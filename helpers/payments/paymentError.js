// A gateway refused or failed. `message` is safe to show users; `code` drives the HTTP status.
//   validation (400) · unauthorized (401) · NOT_READY (409) · network/timeout/server (502) · config (500)
class PaymentError extends Error {
    constructor(message, code = 'unknown', status = 0) {
        super(message);
        this.name = 'PaymentError';
        this.code = code;
        this.status = status;
    }

    httpStatus() {
        if (this.code === 'NOT_READY') return 409;
        if (this.code === 'unauthorized') return 401;
        if (this.code === 'config') return 500;
        if (['network', 'timeout', 'server'].includes(this.code) || this.status >= 500) return 502;
        return 400;
    }
}

module.exports = PaymentError;
