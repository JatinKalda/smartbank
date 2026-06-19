/**
 * SMS Service Configuration
 * Supports multiple providers: Twilio, Nexmo, AWS SNS
 * 
 * Setup:
 * 1. npm install twilio (or nexmo)
 * 2. Create .env file with TWILIO_* credentials
 * 3. Use sendSMS() function in your routes
 */

const smsProvider = process.env.SMS_PROVIDER || 'twilio';

let smsClient = null;

function initSmsClient() {
    if (smsClient !== null) return smsClient;
    try {
        if (smsProvider === 'twilio' && process.env.TWILIO_ACCOUNT_SID) {
            const twilio = require('twilio');
            smsClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        } else if (smsProvider === 'nexmo' && process.env.NEXMO_API_KEY) {
            const Nexmo = require('nexmo');
            smsClient = new Nexmo({
                apiKey: process.env.NEXMO_API_KEY,
                apiSecret: process.env.NEXMO_API_SECRET
            });
        } else if (smsProvider === 'aws' && process.env.AWS_ACCESS_KEY_ID) {
            const AWS = require('aws-sdk');
            smsClient = new AWS.SNS({ region: process.env.AWS_REGION || 'us-east-1' });
        }
    } catch (error) {
        console.warn('SMS client init failed:', error.message);
        smsClient = false;
    }
    if (smsClient === null) smsClient = false;
    return smsClient;
}

async function deliverSms(phone, message) {
    const client = initSmsClient();
    if (!client) {
        console.log(`📱 [dev] SMS to ${phone}: ${message}`);
        return { success: true, dev: true };
    }
    if (smsProvider === 'twilio') {
        await client.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: formatPhoneNumber(phone)
        });
    } else if (smsProvider === 'nexmo') {
        await new Promise((resolve, reject) => {
            client.message.sendSms(
                process.env.NEXMO_FROM,
                formatPhoneNumber(phone),
                message,
                (err, res) => (err ? reject(err) : resolve(res))
            );
        });
    } else if (smsProvider === 'aws') {
        await client.publish({
            Message: message,
            PhoneNumber: formatPhoneNumber(phone)
        }).promise();
    }
    console.log(`✅ SMS sent to ${phone}`);
    return { success: true };
}

/**
 * Format phone number to international format
 */
function formatPhoneNumber(phone) {
    // Remove all non-digit characters
    let cleaned = phone.replace(/\D/g, '');
    
    // If it doesn't start with +, assume it's US
    if (!phone.startsWith('+')) {
        if (cleaned.length === 10) {
            cleaned = '1' + cleaned;
        }
    }
    
    return '+' + cleaned;
}

/**
 * Send 2FA Code via SMS
 */
async function send2FASMSCode(phone, code) {
    const message = `Your HSBC 2FA code is: ${code}. Valid for 10 minutes. Never share this code.`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending 2FA SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendTransactionAlertSMS(phone, transaction) {
    const icons = { credit: '📥', debit: '📤', transfer: '🔄', payment: '💰' };
    const message = `🏦 HSBC Alert: ${icons[transaction.type] || '💳'} ${transaction.type.toUpperCase()} of $${transaction.amount.toFixed(2)} - ${transaction.description}. Balance: $${transaction.balanceAfter?.toFixed(2) || 'N/A'}`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending transaction SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendCardAlertSMS(phone, cardType, action, lastFour) {
    const actionEmojis = { blocked: '🚫', unblocked: '✓', expired: '⏰', limited: '⚙️' };
    const message = `🏦 HSBC Alert: Your ${cardType} card •••• ${lastFour} has been ${actionEmojis[action] || ''} ${action}. Contact us if this wasn't you.`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending card alert SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendLowBalanceAlertSMS(phone, currentBalance, threshold) {
    const message = `🏦 HSBC Alert: Your account balance is low - Current: $${currentBalance.toFixed(2)}. Threshold: $${threshold.toFixed(2)}. Add funds now to avoid overdraft.`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending low balance alert SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendLoginAlertSMS(phone, location, device) {
    const message = `🏦 HSBC Security: New login detected from ${location} on ${device}. If this wasn't you, change your password immediately.`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending login alert SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendOTPSMS(phone, otp) {
    const message = `Your HSBC account verification OTP is: ${otp}. Valid for 5 minutes. Do not share with anyone.`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending OTP SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendBillReminderSMS(phone, billAmount, dueDate) {
    const message = `🏦 HSBC Reminder: You have a bill payment of $${billAmount.toFixed(2)} due by ${dueDate}. Pay now to avoid late fees.`;
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending bill reminder SMS:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendSMS(phone, message) {
    try {
        return await deliverSms(phone, message);
    } catch (error) {
        console.error('❌ Error sending SMS:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    send2FASMSCode,
    sendTransactionAlertSMS,
    sendCardAlertSMS,
    sendLowBalanceAlertSMS,
    sendLoginAlertSMS,
    sendOTPSMS,
    sendBillReminderSMS,
    sendSMS,
    formatPhoneNumber
};
