const rateLimit = require('express-rate-limit');

const json = (message) => ({ message });

// Credential and OTP endpoints — slows down brute force per IP.
exports.authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: json('Too many attempts. Please try again in a few minutes.'),
});

// Anything that sends an email.
exports.emailLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: json('Too many emails requested. Please try again later.'),
});

// Face searches (CPU on our face service, or per-call cost on Rekognition) — per user, not per IP.
exports.faceSearchLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyGenerator: (req) => `user-${req.dbUser?.id}`,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: json('Too many face searches. Please try again in a while.'),
});
