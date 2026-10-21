/**
 * Paystack (South Africa, Nigeria, Ghana, Kenya). Each photographer is a Paystack **subaccount**
 * that settles to their own bank account; clients pay on Paystack's hosted checkout (card, bank,
 * mobile money where available). The photographer's share goes to the subaccount and the platform
 * fee to our main account as `transaction_charge`. Status comes from `transaction/verify` (polled)
 * and signed `charge.success` webhooks.
 *
 * Env: PAYSTACK_SECRET_KEY (sk_test_… / sk_live_…), PAYSTACK_API_URL (tests), and
 * API_PUBLIC_URL for the return page clients land on after paying.
 */
const crypto = require('crypto');
const PaymentError = require('../paymentError');

const COUNTRY_NAMES = { ZA: 'south africa', NG: 'nigeria', GH: 'ghana', KE: 'kenya' };
const CURRENCIES = { ZA: 'ZAR', NG: 'NGN', GH: 'GHS', KE: 'KES' };
const RESOLVABLE = ['NG', 'GH']; // Paystack can look up the account holder's name here
const BANKS_TTL_MS = 6 * 60 * 60 * 1000;
const bankCache = new Map();

const secret = () => process.env.PAYSTACK_SECRET_KEY || '';
const base = () => (process.env.PAYSTACK_API_URL || 'https://api.paystack.co').replace(/\/+$/, '');
const toMinor = (amount) => Math.round(Number(amount) * 100); // all supported currencies have 100 subunits

async function call(method, path, body) {
    if (!secret()) throw new PaymentError('Paystack isn’t configured.', 'config', 500);
    let res;
    try {
        res = await fetch(`${base()}${path}`, {
            method,
            headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        if (e.name === 'TimeoutError') throw new PaymentError('Paystack took too long to answer. Please try again.', 'timeout');
        throw new PaymentError('We could not reach Paystack. Please try again shortly.', 'network');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.ok && data?.status !== false) return data?.data;
    const message = data?.message || 'Paystack could not complete that request.';
    console.error(`Paystack ${method} ${path.split('?')[0]} → ${res.status}: ${message}`);
    if (res.status === 401) throw new PaymentError('Paystack rejected our credentials.', 'config', 500);
    if (res.status >= 500) throw new PaymentError('Paystack is having trouble right now. Please try again shortly.', 'server', res.status);
    throw new PaymentError(message, 'validation', res.status);
}

async function banks(country) {
    const hit = bankCache.get(country);
    if (hit && Date.now() - hit.at < BANKS_TTL_MS) return hit.value;
    const params = new URLSearchParams({ country: COUNTRY_NAMES[country], currency: CURRENCIES[country], perPage: '100' });
    const value = ((await call('GET', `/bank?${params}`)) || [])
        .filter((b) => b.active !== false && b.code)
        .map((b) => ({ value: String(b.code), label: b.name }));
    bankCache.set(country, { at: Date.now(), value });
    return value;
}

function text(value, max) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

module.exports = {
    name: 'paystack',
    label: 'Paystack',

    isConfigured: () => !!secret(),
    testMode: () => secret().startsWith('sk_test_'),

    onboardingForm: async (country, user) => ({
        intro: 'Clients pay through Paystack and your earnings settle straight to your bank account.',
        fields: [
            { key: 'business_name', label: 'Business name', type: 'text', required: true, default: `${user?.name || ''} ${user?.lastname || ''} Photography`.trim() },
            { key: 'bank_code', label: 'Bank', type: 'select', required: true, options: await banks(country) },
            { key: 'account_number', label: 'Account number', type: 'number', required: true, placeholder: 'Your bank account number' },
            { key: 'phone', label: 'Mobile number', type: 'phone', required: true, placeholder: 'With country code, e.g. +27…' },
        ],
    }),

    validateOnboarding: async (values, user, country) => {
        const details = {
            business_name: text(values.business_name, 150) || `${user.name} ${user.lastname} Photography`,
            bank_code: String(values.bank_code || ''),
            account_number: String(values.account_number || '').replace(/\s/g, ''),
            phone: String(values.phone || '').replace(/[\s()-]/g, ''),
        };
        if (details.business_name.length < 2) return { error: 'Enter your business name' };
        const bank = (await banks(country)).find((b) => b.value === details.bank_code);
        if (!bank) return { error: 'Choose your bank' };
        if (!/^\d{6,20}$/.test(details.account_number)) return { error: 'Enter a valid account number' };
        if (!/^\+?[1-9]\d{7,14}$/.test(details.phone)) return { error: 'Enter a valid mobile number with country code' };
        details.bank_name = bank.label;
        if (RESOLVABLE.includes(country)) {
            try {
                const resolved = await call('GET', `/bank/resolve?${new URLSearchParams({ account_number: details.account_number, bank_code: details.bank_code })}`);
                details.account_name = resolved?.account_name || null;
            } catch (e) {
                if (e.code === 'validation') return { error: 'We couldn’t find that account at that bank. Check the number.' };
                throw e;
            }
        }
        return { details };
    },

    createSellerAccount: async (user, details, country) => {
        const sub = await call('POST', '/subaccount', {
            business_name: details.business_name,
            settlement_bank: details.bank_code,
            account_number: details.account_number,
            // Required by Paystack; each payment sets the exact platform fee with transaction_charge.
            percentage_charge: Math.round(Number(process.env.PLATFORM_FEE_PERCENT || 0) * 10000) / 100,
            description: `Photographer ${user.name} ${user.lastname}`,
            primary_contact_email: user.email,
            primary_contact_name: `${user.name} ${user.lastname}`,
            primary_contact_phone: details.phone,
            metadata: { user_id: user.id },
        });
        if (!sub?.subaccount_code) throw new PaymentError('Paystack could not create your payout account.', 'validation', 400);
        return {
            external_id: sub.subaccount_code,
            approved: sub.active !== false,
            display_name: details.business_name,
            details: {
                bank_name: details.bank_name, bank_code: details.bank_code,
                // Only the last digits are kept for display.
                account_last4: details.account_number.slice(-4),
                account_name: sub.account_name || details.account_name || null,
                phone: details.phone, country,
            },
        };
    },

    paymentMethods: () => [{
        id: 'PAYSTACK', label: 'Card, bank or mobile money', wallet: 'Paystack', kind: 'redirect', needs_mobile: false, mobile_hint: null, usd_only: false,
    }],

    checkMethodInput: (methodId) => (methodId === 'PAYSTACK' ? null : 'Choose a payment method'),

    createPayment: async ({ account, order, payer, itemCount }) => {
        const returnUrl = `${(process.env.API_PUBLIC_URL || '').replace(/\/+$/, '')}/api/payments/paystack/return`;
        const init = await call('POST', '/transaction/initialize', {
            email: payer.email,
            amount: toMinor(order.total),
            currency: order.currency,
            reference: order.reference,
            subaccount: account.external_id,
            // Our platform fee; the rest settles to the photographer's subaccount.
            transaction_charge: toMinor(order.fee),
            // The photographer's account bears Paystack's processing fees (as with SmatPay).
            bearer: 'subaccount',
            ...(process.env.API_PUBLIC_URL ? { callback_url: returnUrl } : {}),
            metadata: { order_id: order.id, items: itemCount, payer: payer.name },
        });
        if (!init?.authorization_url) throw new PaymentError('Paystack did not return a payment page.', 'server', 502);
        return {
            kind: 'redirect',
            wallet: 'Paystack',
            payment_code: null,
            redirect_url: init.authorization_url,
            provider_status: 'initialized',
            message: 'Complete the payment on Paystack’s secure page.',
        };
    },

    checkPayment: async (order) => {
        let tx;
        try {
            tx = await call('GET', `/transaction/verify/${encodeURIComponent(order.reference)}`);
        } catch (e) {
            if (e.code === 'validation') return { status: null, provider_status: 'not_found' }; // not started yet
            throw e;
        }
        const s = String(tx?.status || '').toLowerCase();
        // "abandoned" is Paystack's state for an initialized payment nobody has completed yet.
        const status = s === 'success' ? 'PAID' : ['failed', 'reversed'].includes(s) ? 'FAILED' : null;
        return { status, provider_status: tx?.status || null };
    },

    // Paystack exposes no per-subaccount balance to the platform; settlements go to the bank.
    sellerBalance: null,

    /** Signed webhook (x-paystack-signature = HMAC-SHA512 of the raw body with the secret key). */
    webhook: (req) => {
        const signature = req.headers['x-paystack-signature'];
        const expected = crypto.createHmac('sha512', secret()).update(req.rawBody || '').digest('hex');
        if (!signature || !secret() || signature.length !== expected.length
            || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            throw new PaymentError('Invalid signature', 'unauthorized', 401);
        }
        const { event, data } = req.body || {};
        if (event === 'charge.success' && data?.reference) return [{ reference: data.reference, status: 'PAID', provider_status: data.status }];
        return [];
    },
};
