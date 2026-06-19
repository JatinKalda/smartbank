require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const pool = require('./db-mysql');
const { router: chatbotRouter } = require('./chatbot');
const { router: aiChatRouter } = require('./ai-chatbot');
const { signJwt, requireAuth, requireAdmin } = require('./middleware/auth');
const { ensureAuditTable, auditLog } = require('./services/audit-service');
const { registerApiExtensions, otpStore, getNotifications } = require('./routes/api-extensions');

const app = express();
const PORT = 3000;

ensureAuditTable();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Chatbot routes (rule-based)
app.use(chatbotRouter);

// AI Chatbot routes (RAG with fallback)
app.use(aiChatRouter);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/cards', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cards.html'));
});

app.get('/transfers', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'transfers.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Signup Route
app.post('/api/signup', async (req, res) => {
  const { firstName, lastName, email, password, confirmPassword } = req.body;

  console.log('📝 Signup request received:', { firstName, lastName, email });

  // Validation
  if (!firstName || !lastName || !email || !password) {
    console.log('❌ Validation failed: Missing required fields');
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }

  if (password !== confirmPassword) {
    console.log('❌ Validation failed: Passwords do not match');
    return res.status(400).json({ success: false, message: 'Passwords do not match' });
  }

  if (password.length < 6) {
    console.log('❌ Validation failed: Password too short');
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    console.log('✅ Database connection established');

    // Check if email already exists
    console.log('🔍 Checking if email exists:', email);
    const [rows] = await connection.query('SELECT email FROM users WHERE email = ?', [email]);

    if (rows.length > 0) {
      console.log('❌ Email already registered:', email);
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    console.log('✅ Email is unique');

    // Insert new user (role defaults to 'user')
    console.log('💾 Inserting new user...');
    const [result] = await connection.query(
      'INSERT INTO users (firstName, lastName, email, password, role) VALUES (?, ?, ?, ?, ?)',
      [firstName, lastName, email, password, 'user']
    );

    const userId = result.insertId;
    console.log('✅ User inserted successfully as USER role!');

    await connection.query(
      'INSERT INTO accounts (userId, balance, status) VALUES (?, 5000.00, ?)',
      [userId, 'active']
    );
    
    res.json({
      success: true,
      message: 'Account created successfully',
      user: {
        id: userId,
        firstName: firstName,
        lastName: lastName,
        email: email,
        role: 'user'
      },
      token: signJwt({ id: userId, firstName, lastName, email, role: 'user' }),
      redirect: '/dashboard'
    });

    await auditLog(req, {
      action: 'USER_SIGNUP',
      actionType: 'AUTH',
      module: 'auth',
      resourceType: 'user',
      resourceId: String(userId),
      details: { userId, email, role: 'user' }
    });

    getNotifications().sendWelcomeNotification({
      id: userId, firstName, lastName, email
    }).catch(() => {});

  } catch (error) {
    console.error('❌ Signup error:', error.message);
    console.error('Error code:', error.code);
    res.status(500).json({ 
      success: false, 
      message: 'Error creating account: ' + error.message 
    });
  } finally {
    if (connection) {
      connection.release();
      console.log('🔌 Database connection released');
    }
  }
});

// Login Route
app.post('/api/login', async (req, res) => {
  const { email, password, selectedRole } = req.body;

  console.log('🔐 Login request received for:', email, '| Mode:', selectedRole?.toUpperCase() || 'USER');

  // Validation
  if (!email || !password) {
    console.log('❌ Validation failed: Email or password missing');
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    console.log('✅ Database connection established');

    // Check user
    console.log('🔍 Searching for user:', email);
    const [rows] = await connection.query(
      'SELECT * FROM users WHERE email = ? AND password = ?',
      [email, password]
    );

    if (rows.length === 0) {
      console.log('❌ Invalid credentials for:', email);
      await auditLog(req, {
        action: 'LOGIN_FAILED',
        actionType: 'AUTH',
        module: 'auth',
        status: 'failed',
        details: { email }
      });
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const user = rows[0];
    console.log('✅ User found:', user.firstName, user.lastName, '| Actual Role:', user.role.toUpperCase());

    // Verify selected role matches user's actual role
    if (selectedRole) {
      if (selectedRole === 'admin' && user.role !== 'admin') {
        console.log('❌ Role mismatch: Tried to login as admin but user is', user.role.toUpperCase());
        return res.status(403).json({ success: false, message: 'This account is not an admin account.' });
      }
      if (selectedRole === 'user' && user.role === 'admin') {
        console.log('❌ Role mismatch: Admin tried to use user login');
        return res.status(403).json({ success: false, message: 'This is an admin account. Please use Admin Login.' });
      }
    }

    console.log('✅ Login successful for:', user.firstName, user.lastName, '| Role:', user.role.toUpperCase());

    // Store user info including role
    const userInfo = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role
    };

    res.json({
      success: true,
      message: 'Login successful',
      user: userInfo,
      token: signJwt(userInfo),
      redirect: '/dashboard'
    });

    await auditLog(req, {
      action: 'LOGIN_SUCCESS',
      actionType: 'AUTH',
      module: 'auth',
      resourceType: 'user',
      resourceId: String(user.id),
      details: { userId: user.id, email: user.email, role: user.role }
    });

  } catch (error) {
    console.error('❌ Login error:', error.message);
    res.status(500).json({ success: false, message: 'Database error: ' + error.message });
  } finally {
    if (connection) {
      connection.release();
      console.log('🔌 Database connection released');
    }
  }
});

// Transaction Routes
app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.query.userId || req.auth.id;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId required' });
    }

    if (req.auth.role !== 'admin' && String(userId) !== String(req.auth.id)) {
      return res.status(403).json({ success: false, message: 'You can only view your own transactions' });
    }

    const connection = await pool.getConnection();
    const [transactions] = await connection.query(
      'SELECT * FROM transactions WHERE userId = ? ORDER BY createdAt DESC LIMIT 50',
      [userId]
    );
    connection.release();

    res.json({
      success: true,
      transactions: transactions
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching transactions',
      error: error.message 
    });
  }
});

// Create a transfer (debit sender, credit recipient) - atomic DB transaction with locked accounts
app.post('/api/transactions', requireAuth, async (req, res) => {
  let connection;
  try {
    const { amount, description, recipientEmail, recipientId } = req.body;
    const userId = req.auth.role === 'admin' ? (req.body.userId || req.auth.id) : req.auth.id;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid transfer data' });
    }

    if (parseInt(userId) === parseInt(recipientId || 0)) {
      return res.status(400).json({ success: false, message: 'Cannot transfer to yourself' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Resolve recipientId by email if provided
    let toId = recipientId;
    if (!toId && recipientEmail) {
      const [rows] = await connection.query('SELECT id FROM users WHERE email = ? LIMIT 1', [recipientEmail]);
      if (rows.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ success: false, message: 'Recipient not found' });
      }
      toId = rows[0].id;
    }

    if (!toId) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Recipient required' });
    }

    // Lock and fetch sender account with FOR UPDATE (prevents concurrent updates)
    const [senderAccounts] = await connection.query(
      'SELECT id, balance, status FROM accounts WHERE userId = ? FOR UPDATE',
      [userId]
    );

    if (!senderAccounts || senderAccounts.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Sender account not found' });
    }

    const senderAccount = senderAccounts[0];
    const senderBalance = parseFloat(senderAccount.balance);

    if (senderAccount.status !== 'active') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Sender account is not active' });
    }

    if (senderBalance < amount) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: `Insufficient funds. Available: $${senderBalance.toFixed(2)}` });
    }

    // Lock and fetch recipient account with FOR UPDATE
    const [recipientAccounts] = await connection.query(
      'SELECT id, balance, status FROM accounts WHERE userId = ? FOR UPDATE',
      [toId]
    );

    if (!recipientAccounts || recipientAccounts.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Recipient account not found' });
    }

    const recipientAccount = recipientAccounts[0];
    if (recipientAccount.status !== 'active') {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Recipient account is not active' });
    }

    const reference = 'TRX-' + Date.now();
    const senderBalanceAfter = Number((senderBalance - amount).toFixed(2));
    const recipientBalanceAfter = Number((parseFloat(recipientAccount.balance) + amount).toFixed(2));

    // Update accounts atomically
    await connection.query(
      'UPDATE accounts SET balance = ?, lastTransactionAt = NOW() WHERE id = ?',
      [senderBalanceAfter, senderAccount.id]
    );

    await connection.query(
      'UPDATE accounts SET balance = ?, lastTransactionAt = NOW() WHERE id = ?',
      [recipientBalanceAfter, recipientAccount.id]
    );

    // Record debit transaction
    await connection.query(
      `INSERT INTO transactions (userId, type, amount, description, recipientId, reference, balanceAfter, status, createdAt)
       VALUES (?, 'debit', ?, ?, ?, ?, ?, 'completed', NOW())`,
      [userId, amount, description || `Transfer to user ${toId}`, toId, reference, senderBalanceAfter]
    );

    // Record credit transaction
    await connection.query(
      `INSERT INTO transactions (userId, type, amount, description, recipientId, reference, balanceAfter, status, createdAt)
       VALUES (?, 'credit', ?, ?, ?, ?, ?, 'completed', NOW())`,
      [toId, amount, description || `Transfer from user ${userId}`, userId, reference, recipientBalanceAfter]
    );

    await connection.commit();
    connection.release();

    console.log(`✅ Transfer: $${amount} from user ${userId} to user ${toId}, ref: ${reference}`);

    await auditLog(req, {
      action: 'TRANSFER_COMPLETED',
      actionType: 'TRANSACTION',
      module: 'transactions',
      resourceType: 'transaction',
      resourceId: reference,
      details: {
        userId,
        recipientId: toId,
        amount,
        reference,
        senderBalanceAfter,
        recipientBalanceAfter
      }
    });

    getNotifications().sendTransactionNotification(
      { id: userId, email: req.auth.email },
      { type: 'debit', amount: parseFloat(amount), description: description || `Transfer to user ${toId}`, balanceAfter: senderBalanceAfter }
    ).catch(() => {});

    res.json({
      success: true,
      message: 'Transfer completed successfully',
      reference,
      senderBalanceAfter,
      recipientBalanceAfter
    });
  } catch (error) {
    console.error('❌ Error processing transfer:', error.message);
    if (connection) {
      try { await connection.rollback(); } catch (e) {}
      try { connection.release(); } catch (e) {}
    }
    res.status(500).json({ success: false, message: 'Error processing transfer', error: error.message });
  }
});

// Get transaction statistics
app.get('/api/transactions/stats/monthly', requireAuth, async (req, res) => {
  try {
    const userId = req.query.userId || req.auth.id;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId required' });
    }

    if (req.auth.role !== 'admin' && String(userId) !== String(req.auth.id)) {
      return res.status(403).json({ success: false, message: 'You can only view your own statistics' });
    }

    const connection = await pool.getConnection();
    const [stats] = await connection.query(
      `SELECT 
          DATE_FORMAT(createdAt, '%Y-%m') as month,
          type,
          COUNT(*) as count,
          SUM(amount) as total
       FROM transactions 
       WHERE userId = ?
       GROUP BY month, type
       ORDER BY month DESC
       LIMIT 12`,
      [userId]
    );
    connection.release();

    res.json({
      success: true,
      stats: stats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching statistics'
    });
  }
});

// 2FA - Send OTP Code
app.post('/api/user/send-2fa-code', requireAuth, async (req, res) => {
  try {
    const { method, target } = req.body;
    const userId = req.auth.id;
    
    if (!userId || !method || !target) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.setOtp(userId, otpCode, '2fa', { method, target });

    const [users] = await pool.query('SELECT email, firstName FROM users WHERE id = ?', [userId]);
    const user = users[0] || { email: target, firstName: 'User' };

    if (method === 'email') {
      const emailService = require('./services/email-service');
      await emailService.send2FAEmailCode(target || user.email, otpCode);
    } else {
      const smsService = require('./services/sms-service');
      await smsService.send2FASMSCode(target, otpCode);
    }

    console.log(`📧 2FA OTP for user ${userId}: ${otpCode}`);
    
    const response = {
      success: true,
      message: `Code sent to your ${method}`
    };
    if (process.env.NODE_ENV !== 'production') {
      response.testCode = otpCode;
    }
    res.json(response);
  } catch (error) {
    console.error('Error sending 2FA code:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error sending code'
    });
  }
});

// 2FA - Verify OTP Code
app.post('/api/user/verify-2fa', requireAuth, async (req, res) => {
  try {
    const { otpCode } = req.body;
    const userId = req.auth.id;
    
    if (!userId || !otpCode) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!otpStore.verifyOtp(userId, otpCode, '2fa')) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    const connection = await pool.getConnection();
    await connection.query(
      'UPDATE users SET twoFaEnabled = 1 WHERE id = ?',
      [userId]
    );
    connection.release();

    res.json({
      success: true,
      message: '2FA enabled successfully'
    });
  } catch (error) {
    console.error('Error verifying 2FA:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error verifying code'
    });
  }
});

// Get user profile
app.get('/api/user/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.auth.role !== 'admin' && String(id) !== String(req.auth.id)) {
      return res.status(403).json({ success: false, message: 'You can only view your own profile' });
    }
    
    const connection = await pool.getConnection();
    const [users] = await connection.query(
      'SELECT id, firstName, lastName, email, role, createdAt FROM users WHERE id = ?',
      [id]
    );
    connection.release();

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      user: users[0]
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching user'
    });
  }
});

// ADMIN ENDPOINTS
app.use('/api/admin', requireAuth, requireAdmin);

// Admin Dashboard Stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Get total users count
    const [userCount] = await connection.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = userCount[0]?.count || 0;

    // Get total transactions count
    const [txnCount] = await connection.query('SELECT COUNT(*) as count FROM transactions');
    const totalTransactions = txnCount[0]?.count || 0;

    // Get total volume
    const [volumeData] = await connection.query(
      'SELECT SUM(CASE WHEN type = "credit" THEN amount WHEN type = "debit" THEN -amount ELSE 0 END) as total FROM transactions'
    );
    const totalVolume = volumeData[0]?.total || 0;

    connection.release();

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers,
        totalTransactions: totalTransactions,
        totalVolume: parseFloat(totalVolume),
        activeSessions: 1
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching statistics'
    });
  }
});

// Admin - Get All Users
app.get('/api/admin/users', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 100;
    const connection = await pool.getConnection();
    
    const [users] = await connection.query(
      'SELECT id, firstName, lastName, email, role, createdAt FROM users ORDER BY createdAt DESC LIMIT ?',
      [limit]
    );
    connection.release();

    res.json({
      success: true,
      users: users
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching users'
    });
  }
});

// Admin - Get All Transactions
app.get('/api/admin/transactions', async (req, res) => {
  try {
    const allowedTypes = ['credit', 'debit', 'transfer', 'payment'];
    const requestedType = req.query.type && allowedTypes.includes(req.query.type) ? req.query.type : null;
    const limit = req.query.limit ? parseInt(req.query.limit) : 100;
    const connection = await pool.getConnection();
    
    const query = `
      SELECT t.*, u.firstName, u.lastName 
      FROM transactions t
      LEFT JOIN users u ON t.userId = u.id
      WHERE (? IS NULL OR type = ?)
      ORDER BY t.createdAt DESC 
      LIMIT ?
    `;

    const [transactions] = await connection.query(query, [requestedType, requestedType, limit]);
    connection.release();

    // Format response
    const formatted = transactions.map(txn => ({
      id: txn.id,
      userId: txn.userId,
      userName: `${txn.firstName || 'Unknown'} ${txn.lastName || ''}`.trim(),
      type: txn.type,
      amount: txn.amount,
      description: txn.description,
      status: txn.status,
      createdAt: txn.createdAt
    }));

    res.json({
      success: true,
      transactions: formatted
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching transactions'
    });
  }
});

// =============== CARD MANAGEMENT ROUTES ===============

// Get user's cards
app.get('/api/cards', requireAuth, async (req, res) => {
  try {
    const userId = req.query.userId || req.auth.id;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId required' });
    }

    if (req.auth.role !== 'admin' && String(userId) !== String(req.auth.id)) {
      return res.status(403).json({ success: false, message: 'You can only view your own cards' });
    }

    const connection = await pool.getConnection();
    const [cards] = await connection.query(
      'SELECT * FROM cards WHERE userId = ? ORDER BY createdAt DESC',
      [userId]
    );
    connection.release();

    res.json({
      success: true,
      cards: cards || []
    });
  } catch (error) {
    console.error('Error fetching cards:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching cards',
      error: error.message 
    });
  }
});

// Add new card
app.post('/api/cards', requireAuth, async (req, res) => {
  try {
    const { cardNumber, cardholderName, cardType, expiryMonth, expiryYear, provider, dailyLimit, spendingLimit } = req.body;
    const userId = req.auth.role === 'admin' ? (req.body.userId || req.auth.id) : req.auth.id;
    
    if (!userId || !cardNumber || !cardholderName || !cardType) {
      console.log('❌ Missing required fields:', { userId, cardNumber, cardholderName, cardType });
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const connection = await pool.getConnection();
    
    // Check if card with this number already exists
    const [existing] = await connection.query(
      'SELECT id FROM cards WHERE cardNumber = ?',
      [cardNumber]
    );

    if (existing.length > 0) {
      connection.release();
      return res.status(400).json({ success: false, message: 'Card number already exists' });
    }

    // Format expiry date as MM/YY
    const expiryDate = expiryMonth && expiryYear ? 
      `${String(expiryMonth).padStart(2, '0')}/${String(expiryYear).slice(-2)}` : 
      '12/99';

    // Insert new card with correct column names
    const [result] = await connection.query(
      `INSERT INTO cards (userId, cardNumber, cardholderName, cardType, expiryDate, 
                          provider, status, dailyLimit, spendingLimit, isDefault, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, cardNumber, cardholderName, cardType, expiryDate, provider || 'Visa', 'active', dailyLimit || 5000, spendingLimit || 50000, 0]
    );

    connection.release();

    console.log(`✅ Card added successfully for user ${userId}: ${cardNumber.slice(-4)}`);

    res.json({
      success: true,
      message: 'Card added successfully',
      cardId: result.insertId,
      card: {
        id: result.insertId,
        userId: userId,
        cardNumber: cardNumber,
        cardholderName: cardholderName,
        cardType: cardType,
        status: 'active'
      }
    });
  } catch (error) {
    console.error('❌ Error adding card:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Error adding card: ' + error.message,
      error: error.message 
    });
  }
});

// Update card details
app.put('/api/cards/:cardId', requireAuth, async (req, res) => {
  try {
    const cardId = req.params.cardId;
    const { dailyLimit, monthlyLimit, status } = req.body;

    if (!cardId) {
      return res.status(400).json({ success: false, message: 'Card ID required' });
    }

    const connection = await pool.getConnection();

    let updateQuery = 'UPDATE cards SET ';
    const updates = [];
    const values = [];

    if (dailyLimit !== undefined) {
      updates.push('dailyLimit = ?');
      values.push(dailyLimit);
    }
    if (monthlyLimit !== undefined) {
      updates.push('monthlyLimit = ?');
      values.push(monthlyLimit);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    updates.push('updatedAt = NOW()');

    updateQuery += updates.join(', ') + ' WHERE id = ?';
    values.push(cardId);

    const [result] = await connection.query(updateQuery, values);
    connection.release();

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    console.log(`✅ Card ${cardId} updated successfully`);

    res.json({
      success: true,
      message: 'Card updated successfully'
    });
  } catch (error) {
    console.error('❌ Error updating card:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error updating card',
      error: error.message 
    });
  }
});

// Delete card
app.delete('/api/cards/:cardId', requireAuth, async (req, res) => {
  try {
    const cardId = req.params.cardId;

    if (!cardId) {
      return res.status(400).json({ success: false, message: 'Card ID required' });
    }

    const connection = await pool.getConnection();
    const [result] = await connection.query('DELETE FROM cards WHERE id = ?', [cardId]);
    connection.release();

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    console.log(`✅ Card ${cardId} deleted successfully`);

    res.json({
      success: true,
      message: 'Card deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting card:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error deleting card',
      error: error.message 
    });
  }
});

registerApiExtensions(app);

// Start server
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   HSBC Bank Website - MySQL Edition 🚀       ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log('💾 Database: MySQL (hsbc_bank)');
  console.log('👤 User: hsbc_user');
  console.log('✅ Server Ready!');
  console.log('📝 Signup & Login logs will appear below\n');
});
