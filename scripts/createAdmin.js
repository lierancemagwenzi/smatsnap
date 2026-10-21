// Creates the first super admin (later admins are added from the dashboard).
//   npm run admin:create -- --email you@example.com --name Jane --lastname Doe [--password '...']
// Without --password a strong one is generated and printed once.
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const models = require('../models');
const validator = require('../helpers/validator');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
}

(async () => {
    const email = validator.normalizeEmail(arg('email'));
    const name = (arg('name') || '').trim();
    const lastname = (arg('lastname') || '').trim();
    const generated = !arg('password');
    const password = arg('password') || `${crypto.randomBytes(9).toString('base64url')}7a`;

    if (!validator.isValidEmail(email) || !validator.isValidName(name) || !validator.isValidName(lastname)) {
        console.error('Usage: npm run admin:create -- --email you@example.com --name Jane --lastname Doe [--password ...]');
        process.exit(1);
    }
    if (!validator.isStrongPassword(password)) {
        console.error(validator.PASSWORD_RULE_MESSAGE);
        process.exit(1);
    }
    const existing = await models.user.findOne({ where: { email } });
    if (existing) {
        console.error(existing.user_type === 'admin'
            ? 'That admin already exists — reset their password from the dashboard instead.'
            : `That email belongs to a ${existing.user_type} account; use a different email for the admin.`);
        process.exit(1);
    }
    await models.user.create({
        name, lastname, email,
        user_type: 'admin',
        admin_role: 'super_admin',
        status: 'active',
        password: await bcrypt.hash(password, 10),
        email_verified_at: new Date(),
        otp_attempts: 0,
    });
    console.log(`Super admin ${email} created.${generated ? `\nPassword (shown once): ${password}` : ''}`);
    await models.sequelize.close();
})().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
