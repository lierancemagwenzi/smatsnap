const crypto = require('crypto');

// Same scheme as smatpay_whatsapp's cryptoHelper: AES-256-GCM, stored as "iv.tag.ciphertext" (base64).
function key() {
    const raw = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || '', 'base64');
    if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    return raw;
}

module.exports = {
    encrypt: (plain) => {
        if (plain == null) return null;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
        const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
    },

    decrypt: (stored) => {
        if (!stored) return null;
        const [iv, tag, body] = stored.split('.').map((p) => Buffer.from(p, 'base64'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
};
