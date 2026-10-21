const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = {
    normalizeEmail: (email) => (typeof email === 'string' ? email.trim().toLowerCase() : ''),
    isValidEmail: (email) => EMAIL_RE.test(email),
    // At least 8 chars with a letter and a number.
    isStrongPassword: (password) =>
        typeof password === 'string' && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password),
    PASSWORD_RULE_MESSAGE: 'Password must be at least 8 characters and include a letter and a number',
    isValidName: (name) => typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 100,
    USER_TYPES: ['creator', 'client'],
};
