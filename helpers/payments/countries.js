// Where photographers can be paid, and through which gateway. The photographer's country picks
// the gateway (money lands in an account in their country); clients anywhere can pay it.
// PAYMENT_ROUTES (e.g. "ZW:smatpay,ZA:paystack") can override the gateway per country.
const COUNTRIES = {
    ZW: { name: 'Zimbabwe', currency: 'USD', provider: 'smatpay' },
    ZA: { name: 'South Africa', currency: 'ZAR', provider: 'paystack' },
    NG: { name: 'Nigeria', currency: 'NGN', provider: 'paystack' },
    GH: { name: 'Ghana', currency: 'GHS', provider: 'paystack' },
    KE: { name: 'Kenya', currency: 'KES', provider: 'paystack' },
};

function routes() {
    const overrides = Object.fromEntries((process.env.PAYMENT_ROUTES || '')
        .split(',').map((r) => r.trim().split(':')).filter(([c, p]) => c && p)
        .map(([c, p]) => [c.toUpperCase(), p.toLowerCase()]));
    return Object.fromEntries(Object.entries(COUNTRIES).map(([code, c]) => [code, { ...c, provider: overrides[code] || c.provider }]));
}

module.exports = { COUNTRIES, routes };
