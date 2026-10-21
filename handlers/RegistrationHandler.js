const bcrypt = require('bcryptjs');
const models = require('../models');
const tokens = require('../helpers/tokens');
const otpHelper = require('../helpers/otp');
const validator = require('../helpers/validator');
const payments = require('../helpers/payments');
const user = models.user;

const { OTP_PURPOSE } = otpHelper;

// Compared against when the email doesn't exist, so a failed login takes the same
// time whether or not the account exists (no user enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Sends (or, during the resend cooldown, re-uses) a verify-email OTP and returns the
// response body for "password OK, but you still need to confirm your email".
async function otpRequiredResponse(existingUser, message) {
    let resendIn = otpHelper.secondsUntilResendAllowed(existingUser);
    const hasLiveCode = existingUser.otp_purpose === OTP_PURPOSE.VERIFY_EMAIL
        && existingUser.otp_expires_at
        && new Date(existingUser.otp_expires_at).getTime() > Date.now();

    if (!(hasLiveCode && resendIn > 0)) {
        await otpHelper.issue(existingUser, OTP_PURPOSE.VERIFY_EMAIL);
        resendIn = otpHelper.secondsUntilResendAllowed(existingUser);
    }

    return {
        message,
        requires_otp: true,
        otp_token: tokens.sign(existingUser, tokens.PURPOSE.OTP),
        resend_in: resendIn,
        user: existingUser.toPublicJSON(),
    };
}

exports.CheckEmail = async (req, res) => {
    try {
        const email = validator.normalizeEmail(req.body.email);
        if (!validator.isValidEmail(email)) {
            return res.status(400).json({ message: 'Enter a valid email address' });
        }
        const existingUser = await user.findOne({ where: { email } });
        return res.status(200).json({ available: !existingUser });
    } catch (error) {
        console.error('CheckEmail Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.RegisterUser = async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const lastname = (req.body.lastname || '').trim();
        const email = validator.normalizeEmail(req.body.email);
        const { password, user_type } = req.body;

        if (!validator.isValidName(name) || !validator.isValidName(lastname)) {
            return res.status(400).json({ message: 'First name and last name are required' });
        }
        if (!validator.isValidEmail(email)) {
            return res.status(400).json({ message: 'Enter a valid email address' });
        }
        if (!validator.isStrongPassword(password)) {
            return res.status(400).json({ message: validator.PASSWORD_RULE_MESSAGE });
        }
        if (!validator.USER_TYPES.includes(user_type)) {
            return res.status(400).json({ message: 'Account type must be creator or client' });
        }

        const existingUser = await user.findOne({ where: { email } });
        if (existingUser) {
            return res.status(409).json({ message: 'An account with this email already exists' });
        }

        // Photographers get a payout account with their country's gateway at signup (SmatPay:
        // tese-style content-creator signup; Paystack: subaccount), so payout details are required.
        let payout = null;
        if (user_type === 'creator') {
            payout = await payments.checkOnboarding({ name, lastname, email }, req.body.payout);
            if (payout.error) return res.status(400).json({ message: payout.error, field: 'payout' });
        }

        // User row + payout account succeed or fail together.
        let newUser;
        try {
            newUser = await models.sequelize.transaction(async (transaction) => {
                const created = await user.create({
                    name,
                    lastname,
                    email,
                    user_type,
                    status: 'active',
                    password: await bcrypt.hash(password, 10),
                    email_verified_at: null,
                    otp_attempts: 0,
                }, { transaction });
                if (payout) await payments.createAccount(created, payout, { transaction });
                return created;
            });
        } catch (err) {
            if (err instanceof payments.PaymentError) {
                return res.status(err.httpStatus() === 401 ? 502 : err.httpStatus()).json({
                    message: `${payout.provider.label} couldn’t open your payout account: ${err.message}`,
                    field: 'payout',
                });
            }
            throw err;
        }

        // A brand-new account is unverified, so this is exactly the unverified-login
        // path: send the OTP and hand back an OTP-step token.
        const body = await otpRequiredResponse(newUser, 'Account created. We sent a verification code to your email.');
        return res.status(201).json(body);
    } catch (error) {
        console.error('RegisterUser Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.LoginUser = async (req, res) => {
    try {
        const email = validator.normalizeEmail(req.body.email);
        const { password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const existingUser = await user.findOne({ where: { email } });
        const isMatch = await bcrypt.compare(password, existingUser ? existingUser.password : DUMMY_HASH);
        if (!existingUser || !isMatch) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        if (existingUser.status !== 'active') {
            return res.status(403).json({ message: 'This account has been deactivated' });
        }

        // OTP is only required while the email has never been confirmed.
        if (!existingUser.email_verified_at) {
            const body = await otpRequiredResponse(existingUser, 'Please verify your email. We sent you a code.');
            return res.status(200).json(body);
        }

        const session = await tokens.issueSession(existingUser);
        return res.status(200).json({
            message: 'Login successful',
            requires_otp: false,
            ...session,
            user: existingUser.toPublicJSON(),
        });
    } catch (error) {
        console.error('LoginUser Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Bearer: otp_token
exports.VerifyOTP = async (req, res) => {
    try {
        const { otp } = req.body;
        if (!otp) return res.status(400).json({ message: 'Code is required' });

        const existingUser = req.dbUser;
        const result = await otpHelper.check(existingUser, OTP_PURPOSE.VERIFY_EMAIL, otp);
        if (!result.ok) return res.status(result.status).json({ message: result.message });

        existingUser.email_verified_at = new Date();
        const session = await tokens.issueSession(existingUser); // also saves the consumed OTP

        return res.status(200).json({
            message: 'Email verified',
            ...session,
            user: existingUser.toPublicJSON(),
        });
    } catch (error) {
        console.error('VerifyOTP Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Bearer: otp_token
exports.ResendOtp = async (req, res) => {
    try {
        const existingUser = req.dbUser;
        if (existingUser.email_verified_at) {
            return res.status(400).json({ message: 'Email is already verified. Please log in.' });
        }
        const wait = otpHelper.secondsUntilResendAllowed(existingUser);
        if (wait > 0) {
            return res.status(429).json({ message: `Please wait ${wait}s before requesting a new code`, resend_in: wait });
        }
        await otpHelper.issue(existingUser, OTP_PURPOSE.VERIFY_EMAIL);
        return res.status(200).json({
            message: 'A new code has been sent',
            resend_in: otpHelper.secondsUntilResendAllowed(existingUser),
        });
    } catch (error) {
        console.error('ResendOtp Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Always answers the same way so the endpoint can't be used to discover accounts.
exports.ForgotPassword = async (req, res) => {
    try {
        const email = validator.normalizeEmail(req.body.email);
        if (!validator.isValidEmail(email)) {
            return res.status(400).json({ message: 'Enter a valid email address' });
        }

        const existingUser = await user.findOne({ where: { email } });
        if (existingUser && existingUser.status === 'active'
            && otpHelper.secondsUntilResendAllowed(existingUser) === 0) {
            await otpHelper.issue(existingUser, OTP_PURPOSE.RESET_PASSWORD);
        }

        return res.status(200).json({
            message: 'If an account exists for this email, a reset code has been sent.',
            resend_in: 60,
        });
    } catch (error) {
        console.error('ForgotPassword Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.VerifyResetOtp = async (req, res) => {
    try {
        const email = validator.normalizeEmail(req.body.email);
        const { otp } = req.body;
        if (!email || !otp) return res.status(400).json({ message: 'Email and code are required' });

        const existingUser = await user.findOne({ where: { email } });
        if (!existingUser || existingUser.status !== 'active') {
            return res.status(401).json({ message: 'Invalid code' });
        }

        const result = await otpHelper.check(existingUser, OTP_PURPOSE.RESET_PASSWORD, otp);
        if (!result.ok) return res.status(result.status).json({ message: result.message });

        // Receiving the code proves ownership of the inbox.
        if (!existingUser.email_verified_at) existingUser.email_verified_at = new Date();
        await existingUser.save();

        return res.status(200).json({
            message: 'Code verified. Choose a new password.',
            reset_token: tokens.sign(existingUser, tokens.PURPOSE.RESET, {
                pwd: tokens.passwordFingerprint(existingUser),
            }),
        });
    } catch (error) {
        console.error('VerifyResetOtp Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Bearer: reset_token
exports.ResetPassword = async (req, res) => {
    try {
        const { password } = req.body;
        if (!validator.isStrongPassword(password)) {
            return res.status(400).json({ message: validator.PASSWORD_RULE_MESSAGE });
        }

        const existingUser = req.dbUser;
        if (req.user.pwd !== tokens.passwordFingerprint(existingUser)) {
            return res.status(401).json({ message: 'This reset link has already been used. Please start again.' });
        }

        existingUser.password = await bcrypt.hash(password, 10);
        // issueSession replaces the stored refresh token hash, signing out every other device.
        const session = await tokens.issueSession(existingUser);

        return res.status(200).json({
            message: 'Password reset successfully',
            ...session,
            user: existingUser.toPublicJSON(),
        });
    } catch (error) {
        console.error('ResetPassword Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.RefreshToken = async (req, res) => {
    try {
        const { refresh_token } = req.body;
        if (!refresh_token) return res.status(400).json({ message: 'Refresh token is required' });

        let decoded;
        try {
            decoded = tokens.verify(refresh_token, tokens.PURPOSE.REFRESH);
        } catch (err) {
            const msg = err.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid refresh token';
            return res.status(401).json({ message: msg });
        }

        const existingUser = await user.findByPk(decoded.id);
        if (!existingUser || existingUser.status !== 'active' || !existingUser.email_verified_at) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        if (existingUser.refresh_token_hash !== tokens.hashToken(refresh_token)) {
            // An already-rotated refresh token was replayed — treat the session as
            // compromised and revoke it entirely.
            existingUser.refresh_token_hash = null;
            await existingUser.save();
            return res.status(401).json({ message: 'Session expired, please log in again' });
        }

        const session = await tokens.issueSession(existingUser);
        return res.status(200).json({ ...session, user: existingUser.toPublicJSON() });
    } catch (error) {
        console.error('RefreshToken Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Bearer: access token
exports.Logout = async (req, res) => {
    try {
        req.dbUser.refresh_token_hash = null;
        await req.dbUser.save();
        return res.status(200).json({ message: 'Logged out' });
    } catch (error) {
        console.error('Logout Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Bearer: access token
exports.GetAccount = async (req, res) => {
    return res.status(200).json({ user: req.dbUser.toPublicJSON() });
};

// GET /api/registration/payout-countries — where photographers can be paid (and by which gateway).
exports.PayoutCountries = async (req, res) => {
    return res.status(200).json({ countries: payments.countries() });
};

// GET /api/registration/payout-form?country=ZW&name=&lastname= — the payout details form for
// that country's gateway (fields, options, defaults), rendered by the app.
exports.PayoutForm = async (req, res) => {
    const route = payments.forCountry(req.query.country);
    if (!route) return res.status(404).json({ message: 'Payments aren’t available in that country yet' });
    try {
        const user = req.dbUser || { name: String(req.query.name || '').slice(0, 60), lastname: String(req.query.lastname || '').slice(0, 60) };
        const form = await route.provider.onboardingForm(route.country.code, user);
        return res.status(200).json({ country: route.country, ...form });
    } catch (error) {
        console.error('PayoutForm Error:', error.message);
        return res.status(502).json({ message: `Could not load ${route.provider.label} details. Please try again.` });
    }
};
