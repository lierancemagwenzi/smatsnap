const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mailer = require('./mailer');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 60;

const OTP_PURPOSE = {
    VERIFY_EMAIL: 'verify_email',
    RESET_PASSWORD: 'reset_password',
};

function secondsUntilResendAllowed(existingUser) {
    if (!existingUser.otp_sent_at) return 0;
    const elapsed = (Date.now() - new Date(existingUser.otp_sent_at).getTime()) / 1000;
    return Math.max(0, Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsed));
}

// Generates a 6-digit OTP, stores only its hash on the user and emails it.
async function issue(existingUser, purpose) {
    const otp = String(crypto.randomInt(100000, 1000000));
    existingUser.otp_hash = await bcrypt.hash(otp, 10);
    existingUser.otp_purpose = purpose;
    existingUser.otp_expires_at = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    existingUser.otp_attempts = 0;
    existingUser.otp_sent_at = new Date();
    await existingUser.save();

    const subject = purpose === OTP_PURPOSE.RESET_PASSWORD ? 'Reset your password' : 'Verify your email';
    await mailer.SendOtpEmail(existingUser.email, existingUser.name, otp, subject, OTP_TTL_MINUTES);
}

// Returns { ok: true } or { ok: false, status, message }. Consumes the OTP on success.
async function check(existingUser, purpose, otp) {
    if (!existingUser.otp_hash || existingUser.otp_purpose !== purpose) {
        return { ok: false, status: 400, message: 'No active code. Please request a new one.' };
    }
    if (new Date(existingUser.otp_expires_at).getTime() < Date.now()) {
        return { ok: false, status: 400, message: 'This code has expired. Please request a new one.' };
    }
    if (existingUser.otp_attempts >= OTP_MAX_ATTEMPTS) {
        return { ok: false, status: 429, message: 'Too many incorrect attempts. Please request a new code.' };
    }

    const isMatch = await bcrypt.compare(String(otp), existingUser.otp_hash);
    if (!isMatch) {
        existingUser.otp_attempts += 1;
        await existingUser.save();
        return { ok: false, status: 401, message: 'Invalid code' };
    }

    existingUser.otp_hash = null;
    existingUser.otp_purpose = null;
    existingUser.otp_expires_at = null;
    existingUser.otp_attempts = 0;
    return { ok: true };
}

module.exports = { OTP_PURPOSE, issue, check, secondsUntilResendAllowed };
