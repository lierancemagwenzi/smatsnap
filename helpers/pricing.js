// High enough for currencies like NGN/KES; prices are in the photographer's payout currency.
const MAX_PRICE = 1000000;

module.exports = {
    CURRENCY: 'USD', // default before a photographer has a payout account

    // Accepts numbers or numeric strings with up to 2 decimals. Returns a number or null when invalid.
    parsePrice: (value) => {
        if (value === null || value === undefined || value === '') return null;
        const str = String(value).trim();
        if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
        const price = Number(str);
        return price <= MAX_PRICE ? price : null;
    },

    PRICE_RULE_MESSAGE: `Price must be a number between 0 and ${MAX_PRICE} with at most 2 decimals`,

    // A price set on an individual photo/video overrides the photographer's event price.
    effectivePrice: (mediaPrice, eventPrice) =>
        Number(mediaPrice !== null && mediaPrice !== undefined ? mediaPrice : eventPrice || 0),
};
