/**
 * SmatPay merchant calls:
 *  - registration: `auth/content-creator/signup` with a SmatPay product code, exactly as
 *    tese-backend's smatpayHelper.registerMerchant — SmatPay creates the merchant and returns
 *    its sandbox + production keys at once;
 *  - then we act for the photographer with their keys in the background (key sign-in →
 *    payment profile → payment request → tracking), as tese and smatpay_whatsapp do.
 */
const { request, SmatpayError } = require('./apiHelper');
const plane = require('./planeHelper');

const paramCache = new Map();
const PARAM_TTL_MS = 6 * 60 * 60 * 1000;
// Borrowed product codes (another product's) may only register test merchants.
const SANDBOX_ONLY_PRODUCT_CODES = ['Tese'];

async function cachedParam(path, filter) {
    const hit = paramCache.get(path);
    if (hit && Date.now() - hit.at < PARAM_TTL_MS) return hit.value;
    const value = (await request('get', path)).filter(filter);
    paramCache.set(path, { at: Date.now(), value });
    return value;
}

function productCode() {
    const code = (process.env.SMATPAY_PRODUCT_CODE || '').trim();
    if (!code) throw new SmatpayError('Payments are not configured (SMATPAY_PRODUCT_CODE).', 'config', 500);
    if (!plane.isSandbox() && SANDBOX_ONLY_PRODUCT_CODES.includes(code)) {
        throw new SmatpayError(`The "${code}" product code is only for sandbox testing. Set this app's own SmatPay product code.`, 'config', 500);
    }
    return code;
}

module.exports = {
    productCode,

    /**
     * Registers the photographer as a SmatPay merchant (tese's payload). Resolves to SmatPay's
     * account record: { id, accountMerchantId, accountMerchantKey, accountAPIKey,
     * accountMerchantKeyProduction, accountAPIKeyProduction, accountApproved, tradingName, … }.
     */
    contentCreatorSignup: async function (details) {
        const code = productCode();
        const res = await request('post', '/auth/content-creator/signup', {
            body: {
                firstName: details.firstName,
                lastName: details.lastName,
                email: details.email,
                title: details.title,
                tradingName: details.tradingName,
                businessDescription: details.businessDescription,
                telephoneNumber: details.phone,
                tradingAddress: details.tradingAddress,
                province: details.province,
                country: details.country,
                gender: details.gender,
                dateOfBirth: details.dateOfBirth,
                individualMobile: details.phone,
                contentCreatorID: details.userId,
                productCode: code,
                product_code: code,
            },
            timeoutMs: 60000,
        });
        const account = res?.data;
        if (!account?.accountMerchantId) {
            throw new SmatpayError(res?.message || 'SmatPay could not create your merchant account.', 'validation', 400);
        }
        return account;
    },

    // Public lists for the registration form.
    titles: () => cachedParam('/param/titles', (t) => t.titleName),
    provinces: () => cachedParam('/param/provinces', (p) => p.provinceName),

    /** Key sign-in on the current plane → { token, user: { accountId, … } }. */
    keyLogin: async function (merchantId, merchantKey, merchantApiKey) {
        const res = await request('post', plane.keyAuthPath(), { body: { merchantId, merchantKey, merchantApiKey } });
        if (!res?.token) throw new SmatpayError(res?.errorResponse?.errorMessage || 'Merchant sign-in failed.', 'unauthorized', 401);
        return res;
    },

    /** [{ id, paymentProfileNumber, paymentProfileApproved, … }] on the current plane. */
    paymentProfiles: async function (token, accountId) {
        const res = await request('get', `${plane.paymentProfilesBase()}${accountId}`, { token });
        return Array.isArray(res) ? res : [];
    },

    /**
     * Charges a client on the merchant's behalf (as tese's PurchaseVideo and the bot's
     * requestPayment). `additionalFees` is the platform fee. Resolves to the provider initiation
     * { status, paymentReference, paymentCode, paymentRedirectUrl, paymentVisaSkinnedUrl, … }.
     */
    requestPayment: async function ({ merchantId, merchantKey, merchantApiKey, accountId, profileNumber, walletName, amount, fees, currency, payerName, reference, payerMobile, description }) {
        const res = await request('post', `${plane.initBase()}/authenticate/merchant/wallet`, {
            body: {
                merchantId, merchantKey, merchantApiKey,
                walletName,
                amount: Number(amount).toFixed(2),
                paymentCurrency: currency,
                paymentDescription: description,
                payerName,
                payerReference: reference,
                payerAccountId: String(accountId),
                profileId: Number(profileNumber),
                additionalFees: Number(fees || 0).toFixed(2),
                ...(payerMobile ? { payerMobile } : {}),
            },
            timeoutMs: 60000,
        });
        const init = res?.paymentInitiationResponse;
        const failure = res?.auth?.errorResponse?.errorMessage || res?.errorResponse?.errorMessage;
        if (!init || /^(failed|failure|error|rejected)$/i.test(init.status || '')) {
            throw new SmatpayError(init?.paymentResponseMessage || failure || 'The payment could not be started.', 'validation', 400);
        }
        return init;
    },

    /** Money paid to the merchant, less payouts: [{ currency, amount }] (as smatpay_whatsapp). */
    payoutBalance: async function (token, merchantId) {
        const res = await request('get', `${plane.merchantApiBase()}/merchantPayoutBalance?merchantId=${encodeURIComponent(merchantId)}`, { token });
        return Array.isArray(res?.data) ? res.data : [];
    },

    /** The merchant's transactions, newest first: { rows, total } (merchantReportList). */
    transactions: async function (token, merchantId, { pageNo = 1, pageSize = 20 } = {}) {
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const params = new URLSearchParams({
            merchantId, start: '2020-01-01', end: tomorrow, pageNo: String(pageNo), pageSize: String(pageSize),
            // The backend fails without orderBy.
            orderBy: 'desc',
        });
        const res = await request('get', `${plane.merchantApiBase()}/merchantReportList?${params}`, { token });
        return { rows: Array.isArray(res?.content) ? res.content : [], total: Number(res?.totalElements) || 0 };
    },

    /** Where a payment stands: the provider row, whose `status` is Pending, Paid, Failed, Cancelled… */
    trackPayment: async function (reference) {
        const rows = await request('post', `${plane.initBase()}/trackPaymentTransaction`, { body: { transactionReference: reference } });
        if (!Array.isArray(rows) || !rows.length) return null;
        return rows.find((r) => r.paymentReference === reference) || rows[0];
    },
};
