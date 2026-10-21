/**
 * Payment gateways behind one interface. Each provider (providers/*.js) implements:
 *
 *   name, label
 *   isConfigured()                         → bool (credentials present)
 *   onboardingForm(country, user)          → { fields: [{ key, label, type, required, options?, placeholder?, help?, default? }], intro }
 *   validateOnboarding(values, user, country) → { details } | { error }
 *   testMode()?                            → bool (sandbox / test keys)
 *   checkMethodInput(methodId, { payerMobile }) → error message | null
 *   createSellerAccount(user, details, country) → { external_id, credentials?, approved, display_name, details }
 *   paymentMethods(account)                → [{ id, label, wallet (≤20 chars), kind: prompt|code|redirect, needs_mobile, mobile_hint, usd_only }]
 *   createPayment({ account, order, methodId, payer, itemCount })
 *                                          → { kind, payment_code?, redirect_url?, message, provider_status? }
 *   checkPayment(order, account)           → { status: 'PAID'|'FAILED'|'CANCELLED'|null, provider_status }
 *   sellerBalance(account)?                → [{ currency, amount }]   (optional)
 *   webhook(req)?                          → [{ reference, status }]  (optional; signature checked)
 *
 * Photographers choose a country; its gateway (helpers/payments/countries.js) holds their payout
 * account. Checkout charges the gateway of the photographer being paid.
 */
const { routes } = require('./countries');

const PROVIDERS = {
    smatpay: () => require('./providers/smatpay'),
    paystack: () => require('./providers/paystack'),
};

const loaded = {};
function provider(name) {
    if (!PROVIDERS[name]) throw new Error(`Unknown payment provider "${name}"`);
    loaded[name] = loaded[name] || PROVIDERS[name]();
    return loaded[name];
}

/** Countries photographers can sell from right now (their gateway is configured). */
function countries() {
    return Object.entries(routes())
        .filter(([, c]) => PROVIDERS[c.provider] && provider(c.provider).isConfigured())
        .map(([code, c]) => ({ code, name: c.name, currency: c.currency, provider: c.provider, provider_label: provider(c.provider).label }));
}

function forCountry(code) {
    const c = countries().find((x) => x.code === String(code || '').toUpperCase());
    return c ? { country: c, provider: provider(c.provider) } : null;
}

/** The photographer's payout account (ready or not), or null. */
async function accountOf(userId) {
    return require('../../models').payout_account.findOne({ where: { user_id: userId } });
}

/** The ready payout account of a photographer and its provider, or null. */
async function readyAccount(userId) {
    const account = await accountOf(userId);
    if (!account || !account.isReady) return null;
    return { account, provider: provider(account.provider) };
}

/**
 * Checks the onboarding form for the photographer's country. `user` needs name/lastname/email
 * (signup checks before the user row exists). Returns { country, provider, details } | { error }.
 */
async function checkOnboarding(user, { country, values } = {}) {
    const route = forCountry(country);
    if (!route) return { error: 'Choose a country where payments are available' };
    const checked = await route.provider.validateOnboarding(values && typeof values === 'object' ? values : {}, user, route.country.code);
    if (checked.error) return { error: checked.error };
    return { country: route.country, provider: route.provider, details: checked.details };
}

/** Opens the seller account with the gateway and stores it. Gateway refusals throw a PaymentError. */
async function createAccount(user, checked, { transaction } = {}) {
    const created = await checked.provider.createSellerAccount(user, checked.details, checked.country.code);
    const cryptoHelper = require('../cryptoHelper');
    return require('../../models').payout_account.create({
        user_id: user.id,
        provider: checked.provider.name,
        country: checked.country.code,
        currency: checked.country.currency,
        status: 'ready',
        external_id: created.external_id,
        credentials_enc: created.credentials ? cryptoHelper.encrypt(JSON.stringify(created.credentials)) : null,
        approved: !!created.approved,
        display_name: created.display_name,
        details: JSON.stringify(created.details || {}),
    }, { transaction });
}

/** checkOnboarding + createAccount. Returns { account } | { error }. */
async function openAccount(user, input, { transaction } = {}) {
    const checked = await checkOnboarding(user, input);
    if (checked.error) return checked;
    return { account: await createAccount(user, checked, { transaction }) };
}

/** Whether a gateway is running against its test environment (shown as "Test mode"). */
function testMode(name) {
    const p = provider(name);
    return typeof p.testMode === 'function' ? p.testMode() : false;
}

module.exports = {
    provider, countries, forCountry, accountOf, readyAccount, checkOnboarding, createAccount, openAccount, testMode,
    PaymentError: require('./paymentError') };
