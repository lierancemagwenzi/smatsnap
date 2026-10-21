const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('./env');

// Every JWT carries a `purpose` so a token minted for one step can't be replayed
// against another: an OTP-step token can't hit the dashboard API, a reset token
// can't log you in, a refresh token can't be used as an access token.
const PURPOSE = {
    ACCESS: 'access',
    REFRESH: 'refresh',
    OTP: 'otp',       // between password check and OTP confirmation (unverified email)
    RESET: 'reset',   // after a password-reset OTP was confirmed, before the new password is set
};

const EXPIRY = {
    [PURPOSE.ACCESS]: '1h',
    [PURPOSE.REFRESH]: '30d',
    [PURPOSE.OTP]: '15m',
    [PURPOSE.RESET]: '15m',
};

function sign(existingUser, purpose, extraClaims = {}) {
    return jwt.sign(
        { ...extraClaims, id: existingUser.id, email: existingUser.email, user_type: existingUser.user_type, purpose },
        env.jwtSecret(),
        { expiresIn: EXPIRY[purpose], jwtid: crypto.randomUUID() }
    );
}

function verify(token, purpose) {
    const decoded = jwt.verify(token, env.jwtSecret());
    if (decoded.purpose !== purpose) {
        const err = new Error('Wrong token purpose');
        err.name = 'JsonWebTokenError';
        throw err;
    }
    return decoded;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Short fingerprint of the user's current password hash. Embedded in reset tokens so
// a reset token stops working the moment the password changes (single use).
function passwordFingerprint(existingUser) {
    return hashToken(existingUser.password || '').slice(0, 16);
}

// Issues a fresh access + refresh pair and stores the refresh token's hash on the
// user, which invalidates any refresh token issued before it (rotation).
async function issueSession(existingUser) {
    const token = sign(existingUser, PURPOSE.ACCESS);
    const refreshToken = sign(existingUser, PURPOSE.REFRESH);
    existingUser.refresh_token_hash = hashToken(refreshToken);
    existingUser.last_login_at = new Date();
    await existingUser.save();
    return { token, refresh_token: refreshToken };
}

module.exports = { PURPOSE, sign, verify, hashToken, passwordFingerprint, issueSession };
