/**
 * Which SmatPay plane we talk to (SMATPAY_PLANE): `production` (real money) or `sandbox`
 * (simulated outcomes). Same switch as smatpay_whatsapp / the customer app's plane.ts.
 * Merchant keys come in a sandbox and a production pair; the plane picks which one is used.
 */
module.exports = {
    isSandbox: () => (process.env.SMATPAY_PLANE || 'sandbox') !== 'production',
    initBase() { return this.isSandbox() ? '/sandbox/init' : '/init'; },
    keyAuthPath() { return this.isSandbox() ? '/auth/authenticate/sandbox/merchant' : '/auth/authenticate/merchant'; },
    /** Merchant reports and balances (transaction_service, or its sandbox twin). */
    merchantApiBase() { return this.isSandbox() ? '/sandbox/api' : '/api'; },
    paymentProfilesBase() { return this.isSandbox() ? '/api/merchant/sandbox/paymentprofile/' : '/api/merchant/paymentprofile/'; },
};
