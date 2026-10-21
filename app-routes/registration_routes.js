'use strict';

module.exports = function (app) {
    const authMiddleWare = require('../middleware/authentication');
    const { authLimiter, emailLimiter } = require('../middleware/rate_limit');
    const registrationHandler = require('../handlers/RegistrationHandler');

    app.route('/api/registration/check-email')
        .post(authLimiter, registrationHandler.CheckEmail);
    app.route('/api/registration/payout-countries')
        .get(registrationHandler.PayoutCountries);
    app.route('/api/registration/payout-form')
        .get(registrationHandler.PayoutForm);
    app.route('/api/registration/register')
        .post(authLimiter, emailLimiter, registrationHandler.RegisterUser);

    app.route('/api/auth/login')
        .post(authLimiter, registrationHandler.LoginUser);
    app.route('/api/auth/verify-otp')
        .post(authLimiter, authMiddleWare.authenticateOtpToken, registrationHandler.VerifyOTP);
    app.route('/api/auth/resend-otp')
        .post(emailLimiter, authMiddleWare.authenticateOtpToken, registrationHandler.ResendOtp);

    app.route('/api/auth/forgot-password')
        .post(emailLimiter, registrationHandler.ForgotPassword);
    app.route('/api/auth/verify-reset-otp')
        .post(authLimiter, registrationHandler.VerifyResetOtp);
    app.route('/api/auth/reset-password')
        .post(authLimiter, authMiddleWare.authenticateResetToken, registrationHandler.ResetPassword);

    app.route('/api/auth/refresh-token')
        .post(authLimiter, registrationHandler.RefreshToken);
    app.route('/api/auth/logout')
        .post(authMiddleWare.authenticateToken, registrationHandler.Logout);
    app.route('/api/auth/get-account')
        .get(authMiddleWare.authenticateToken, registrationHandler.GetAccount);
};
