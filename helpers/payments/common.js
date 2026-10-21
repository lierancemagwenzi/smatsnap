// Checkout rules shared by every payment gateway.
const crypto = require('crypto');

const round2 = (n) => Math.round(Number(n) * 100) / 100;

module.exports = {
    round2,
    PENDING_TIMEOUT_MINUTES: 30,

    /** Platform fee charged on top of the photographer's prices. */
    fee: (subtotal) => {
        if (subtotal <= 0) return 0;
        const percent = Number(process.env.PLATFORM_FEE_PERCENT || 0);
        const fixed = Number(process.env.PLATFORM_FEE_FIXED || 0);
        return round2(subtotal * percent + fixed);
    },

    /** Our order reference — also what gateways get as the merchant/transaction reference. */
    reference: () => {
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        return `LUM-${stamp}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    },

    downloadDays: () => Number(process.env.PURCHASE_DOWNLOAD_DAYS || 30),
};
