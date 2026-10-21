const models = require('../models');
const tokens = require('../helpers/tokens');
const user = models.user;

function bearerToken(req) {
    const authHeader = req.headers['authorization'];
    return authHeader && authHeader.split(' ')[1];
}

// Builds a middleware that accepts only JWTs minted for `purpose`.
function requireToken(purpose, { requireVerified }) {
    return async (req, res, next) => {
        try {
            req.user = undefined;
            const token = bearerToken(req);
            if (!token) {
                return res.status(401).json({ message: 'No token provided' });
            }

            const decoded = tokens.verify(token, purpose);

            const dbUser = await user.findByPk(decoded.id);
            if (!dbUser || dbUser.status !== 'active') {
                return res.status(401).json({ message: 'User account not found or deactivated' });
            }

            if (requireVerified && !dbUser.email_verified_at) {
                return res.status(403).json({ message: 'Email not verified', requires_otp: true });
            }

            req.user = decoded;
            req.dbUser = dbUser;
            next();
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Token expired' });
            }
            if (err.name === 'JsonWebTokenError') {
                return res.status(401).json({ message: 'Invalid token' });
            }
            console.error('Auth Error:', err.message);
            return res.status(500).json({ message: 'Internal server error' });
        }
    };
}

// Normal API access (dashboard etc.) — verified users only.
exports.authenticateToken = requireToken(tokens.PURPOSE.ACCESS, { requireVerified: true });

// The OTP step of login/registration — issued while email_verified_at is still null.
exports.authenticateOtpToken = requireToken(tokens.PURPOSE.OTP, { requireVerified: false });

// Setting a new password after the reset OTP was confirmed.
exports.authenticateResetToken = requireToken(tokens.PURPOSE.RESET, { requireVerified: false });
