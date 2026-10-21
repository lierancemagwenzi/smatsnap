/**
 * SmatPay (Zimbabwe). Photographers are SmatPay merchants registered tese-style
 * (`auth/content-creator/signup` with SMATPAY_PRODUCT_CODE, which returns the merchant's keys at
 * once); payments are requested on their merchant with those keys in the background.
 * Low-level calls live in helpers/smatpay/*.
 */
const merchantApi = require('../../smatpay/merchantApiHelper');
const plane = require('../../smatpay/planeHelper');
const { SmatpayError } = require('../../smatpay/apiHelper');

const GENDERS = ['Male', 'Female'];
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const sessions = new Map(); // payout account id → { token, expiresAt, accountId, profileNumber }

// Rails as SmatPay names them (as smatpay_whatsapp's merchantRequestHelper).
const METHODS = {
    ECOCASH: { walletName: 'Ecocash', label: 'EcoCash', kind: 'prompt', mobile: /^07[78]\d{7}$/, hint: 'EcoCash number, e.g. 0771234567' },
    OMARI: { walletName: 'Omari', label: 'O’mari', kind: 'prompt', mobile: /^071\d{7}$/, hint: 'O’mari (NetOne) number, e.g. 0711234567' },
    INNBUCKS: { walletName: 'Innbucks', label: 'InnBucks', kind: 'code', usdOnly: true },
    ZIMSWITCH: { walletName: 'ZimSwitch', label: 'ZimSwitch', kind: 'redirect' },
    VISA: { walletName: 'Visa', label: 'Visa', kind: 'redirect' },
    MASTERCARD: { walletName: 'Mastercard', label: 'Mastercard', kind: 'redirect' },
};

function jwtExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return payload.exp ? payload.exp * 1000 : Date.now() + 60 * 60 * 1000;
    } catch {
        return Date.now() + 30 * 60 * 1000;
    }
}

function text(value, max) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function ageOn(dateStr) {
    const dob = new Date(`${dateStr}T00:00:00Z`);
    const now = new Date();
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    if (now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())) age--;
    return age;
}

/** 07… / 2637… → +2637… (the format the SmatPay apps send). */
function normalizePhone(raw) {
    const digits = String(raw || '').replace(/[\s()-]/g, '');
    if (/^07\d{8}$/.test(digits)) return `+263${digits.slice(1)}`;
    if (/^2637\d{8}$/.test(digits)) return `+${digits}`;
    if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
    return null;
}

async function lists() {
    const [titles, provinces] = await Promise.all([merchantApi.titles(), merchantApi.provinces()]);
    return { titles: [...new Set(titles.map((t) => t.titleName))], provinces: provinces.map((p) => p.provinceName) };
}

/** Key sign-in session for a payout account (token reused until near expiry). */
async function session(account, { fresh = false } = {}) {
    const keys = account.credentials()?.[plane.isSandbox() ? 'sandbox' : 'production'];
    if (!keys?.key || !keys?.apiKey) {
        throw new SmatpayError(plane.isSandbox()
            ? 'This photographer can’t receive payments yet.'
            : 'This photographer isn’t approved for live payments yet.', 'NOT_READY', 409);
    }
    let s = sessions.get(account.id);
    if (fresh || !s || s.expiresAt - Date.now() < TOKEN_MARGIN_MS) {
        const auth = await merchantApi.keyLogin(account.external_id, keys.key, keys.apiKey);
        const accountId = auth.user?.accountId || account.detailsJSON().smatpay_account_id;
        const profiles = await merchantApi.paymentProfiles(auth.token, accountId);
        const profile = profiles.find((p) => p.paymentProfileApproved) || profiles[0];
        if (!profile) throw new SmatpayError('This photographer’s payment profile isn’t set up yet.', 'NOT_READY', 409);
        s = { token: auth.token, expiresAt: jwtExpiry(auth.token), accountId, profileNumber: profile.paymentProfileNumber };
        sessions.set(account.id, s);
    }
    return { ...s, merchantId: account.external_id, merchantKey: keys.key, merchantApiKey: keys.apiKey };
}

/** SmatPay keeps only the latest key sign-in per merchant: on a 401, sign in again once and retry. */
async function withSession(account, call) {
    try {
        return await call(await session(account));
    } catch (e) {
        if (e.status !== 401) throw e;
        return call(await session(account, { fresh: true }));
    }
}

module.exports = {
    name: 'smatpay',
    label: 'SmatPay',
    METHODS,

    isConfigured: () => !!process.env.SMATPAY_API_URL && !!process.env.SMATPAY_PRODUCT_CODE,
    testMode: () => plane.isSandbox(),

    onboardingForm: async (country, user) => {
        const { titles, provinces } = await lists();
        return {
            intro: 'Clients pay you directly into your own SmatPay merchant account. We open it with these details.',
            fields: [
                { key: 'title', label: 'Title', type: 'select', required: true, options: titles.map((t) => ({ value: t, label: t })), style: 'chips' },
                { key: 'gender', label: 'Gender', type: 'select', required: true, options: GENDERS.map((g) => ({ value: g, label: g })), style: 'chips' },
                { key: 'date_of_birth', label: 'Date of birth', type: 'date', required: true, min_age: 18 },
                { key: 'phone', label: 'Mobile number', type: 'phone', required: true, placeholder: '0771234567' },
                { key: 'trading_name', label: 'Business name', type: 'text', required: true, default: `${user?.name || ''} ${user?.lastname || ''} Photography`.trim() },
                { key: 'business_description', label: 'What you do', type: 'text', required: true, default: 'Event photography and videography' },
                { key: 'trading_address', label: 'Business address', type: 'text', required: true, placeholder: '12 Samora Machel Ave, Harare' },
                { key: 'province', label: 'Province', type: 'select', required: true, options: provinces.map((p) => ({ value: p, label: p })) },
            ],
        };
    },

    validateOnboarding: async (values, user) => {
        const details = {
            title: text(values.title, 20),
            gender: text(values.gender, 20),
            dateOfBirth: text(values.date_of_birth, 10),
            phone: normalizePhone(values.phone),
            tradingName: text(values.trading_name, 150) || `${user.name} ${user.lastname} Photography`,
            businessDescription: text(values.business_description, 255) || 'Event photography and videography',
            tradingAddress: text(values.trading_address, 255),
            province: text(values.province, 100),
            country: 'Zimbabwe',
        };
        let opts = null;
        try { opts = await lists(); } catch { /* SmatPay lists unavailable: basic checks only */ }
        if (!details.title || (opts && !opts.titles.includes(details.title))) return { error: 'Choose your title' };
        if (!GENDERS.includes(details.gender)) return { error: 'Choose your gender' };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(details.dateOfBirth) || Number.isNaN(Date.parse(details.dateOfBirth))) return { error: 'Enter your date of birth' };
        if (ageOn(details.dateOfBirth) < 18) return { error: 'You must be 18 or older to sell photos' };
        if (!details.phone) return { error: 'Enter a valid mobile number, e.g. 0771234567' };
        if (details.tradingName.length < 2) return { error: 'Enter your business name' };
        if (details.tradingAddress.length < 5) return { error: 'Enter your business address' };
        if (!details.province || (opts && !opts.provinces.includes(details.province))) return { error: 'Choose your province' };
        return { details };
    },

    createSellerAccount: async (user, details) => {
        const account = await merchantApi.contentCreatorSignup({ ...details, firstName: user.name, lastName: user.lastname, email: user.email, userId: user.id });
        return {
            external_id: String(account.accountMerchantId),
            credentials: {
                sandbox: { key: account.accountMerchantKey || null, apiKey: account.accountAPIKey || null },
                production: { key: account.accountMerchantKeyProduction || null, apiKey: account.accountAPIKeyProduction || null },
            },
            approved: account.accountApproved === true,
            display_name: account.tradingName || details.tradingName,
            details: {
                smatpay_account_id: account.id, product_code: merchantApi.productCode(),
                title: details.title, gender: details.gender, date_of_birth: details.dateOfBirth, phone: details.phone,
                trading_name: details.tradingName, business_description: details.businessDescription,
                trading_address: details.tradingAddress, province: details.province, country: details.country,
            },
        };
    },

    paymentMethods: (account) => Object.entries(METHODS)
        .filter(([, m]) => !m.usdOnly || account.currency === 'USD')
        .map(([id, m]) => ({ id, label: m.label, wallet: m.label, kind: m.kind, needs_mobile: m.kind === 'prompt', mobile_hint: m.hint || null, usd_only: !!m.usdOnly })),

    /** Validates method-specific input before an order is created. Returns an error message or null. */
    checkMethodInput: (methodId, { payerMobile }) => {
        const m = METHODS[methodId];
        if (!m) return 'Choose a payment method';
        if (m.kind === 'prompt' && !m.mobile.test(payerMobile || '')) return `Enter your ${m.hint}`;
        return null;
    },

    createPayment: async ({ account, order, methodId, payer, itemCount }) => {
        const m = METHODS[methodId];
        const init = await withSession(account, (s) => merchantApi.requestPayment({
            merchantId: s.merchantId, merchantKey: s.merchantKey, merchantApiKey: s.merchantApiKey,
            accountId: s.accountId, profileNumber: s.profileNumber,
            walletName: m.walletName,
            amount: order.subtotal,
            fees: order.fee,
            currency: order.currency,
            payerName: payer.name,
            reference: order.reference,
            payerMobile: m.kind === 'prompt' ? payer.mobile : undefined,
            description: `Event photos (${itemCount} item${itemCount === 1 ? '' : 's'})`,
        }));
        const redirect = init.paymentRedirectUrl || init.paymentVisaSkinnedUrl || init.paymentMasterCardSkinnedUrl || init.paymentZimSwitchSkinnedUrl || null;
        if (m.kind === 'redirect' && !redirect) throw new SmatpayError('SmatPay did not return a card payment page. Please try another method.', 'server', 502);
        const total = `${order.currency} ${Number(order.total).toFixed(2)}`;
        return {
            kind: m.kind,
            wallet: m.walletName,
            payment_code: m.kind === 'code' ? (init.paymentCode || init.paymentToken || null) : null,
            redirect_url: m.kind === 'redirect' ? redirect : null,
            provider_status: init.status || null,
            message: m.kind === 'prompt' ? `Approve the ${m.label} prompt on ${payer.mobile} to pay ${total}.`
                : m.kind === 'code' ? `Open InnBucks and pay ${total} with the code shown.`
                    : 'Complete the payment on the secure card page.',
        };
    },

    checkPayment: async (order) => {
        const row = await merchantApi.trackPayment(order.reference);
        const s = String(row?.status || '').toLowerCase();
        let status = null;
        if (['paid', 'success', 'successful', 'completed'].includes(s)) status = 'PAID';
        else if (['cancelled', 'canceled'].includes(s)) status = 'CANCELLED';
        else if (['failed', 'failure', 'declined', 'rejected', 'expired', 'timedout', 'error'].includes(s)) status = 'FAILED';
        return { status, provider_status: row?.status || null };
    },

    /** What clients paid the merchant, less payouts (SmatPay merchantPayoutBalance). */
    sellerBalance: async (account) => withSession(account, async (s) => (await merchantApi.payoutBalance(s.token, s.merchantId))
        .map((r) => ({ currency: r.currency || account.currency, amount: Number(r.amount || 0) }))),
};
