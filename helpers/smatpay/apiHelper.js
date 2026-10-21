/**
 * HTTP calls to SmatPay (SMATPAY_API_URL). Every failure is a SmatpayError whose message is
 * safe to show to users; the technical reason is logged. Modelled on smatpay_whatsapp's
 * smatpayApiHelper (and the customer app's src/lib/api/client.ts). TLS is verified.
 */
const DEFAULT_TIMEOUT_MS = 30000;

const PaymentError = require('../payments/paymentError');

class SmatpayError extends PaymentError {
    constructor(message, code = 'unknown', status = 0) {
        super(message, code, status);
        this.name = 'SmatpayError';
    }
}

/** Unwraps `Gson().toJson(list.toString())` validation errors, as the SmatPay apps do. */
function cleanMessage(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let text = raw.trim();
    if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
    if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
    const joined = text.split(/,\s*(?=[A-Z])/).map((p) => p.trim()).filter(Boolean).join('. ');
    return /[.!?]$/.test(joined) ? joined : `${joined}.`;
}

function messageFromBody(body, fallback) {
    if (body && typeof body === 'object') {
        return cleanMessage(body.errorResponse?.errorMessage) ?? cleanMessage(body.message) ?? fallback;
    }
    return fallback;
}

async function request(method, path, { body, token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const base = (process.env.SMATPAY_API_URL || '').replace(/\/+$/, '');
    if (!base) throw new SmatpayError('Payments are not configured.', 'config');
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
        response = await fetch(`${base}${path}`, {
            method: method.toUpperCase(),
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        if (e.name === 'TimeoutError') throw new SmatpayError('SmatPay took too long to answer. Please try again.', 'timeout');
        throw new SmatpayError('We could not reach SmatPay. Please try again shortly.', 'network');
    }

    const text = await response.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain text body */ }

    const { status } = response;
    if (status >= 200 && status < 300) return data;
    const reason = messageFromBody(data, typeof data === 'string' ? data.slice(0, 300) : '');
    console.error(`SmatPay ${method.toUpperCase()} ${path.split('?')[0]} → ${status}: ${reason || '(no message)'}`);
    if (status === 401) throw new SmatpayError(reason || 'SmatPay sign-in failed.', 'unauthorized', 401);
    if (status >= 500) {
        const error = new SmatpayError('SmatPay is having trouble right now. Please try again shortly.', 'server', status);
        error.reason = reason;
        throw error;
    }
    throw new SmatpayError(reason || 'SmatPay could not complete that request.', 'validation', status);
}

/** Backend: "Success"/"Verified" ok, "Failed"/"false" not. */
function expectSuccess(response, fallback) {
    if (!response || response.status === 'Failed' || response.status === 'false') {
        throw new SmatpayError(cleanMessage(response?.message) || fallback, 'validation', 400);
    }
    return response;
}

module.exports = { SmatpayError, request, expectSuccess };
