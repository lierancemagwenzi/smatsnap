// Client checkout. Each photographer is paid through their own payout account with the gateway
// of their country (helpers/payments: SmatPay in Zimbabwe, Paystack elsewhere), so one order =
// one payment to one photographer for one event; the app checks a multi-photographer cart out
// group by group. Prices are always recomputed here.
const path = require('path');
const { Op } = require('sequelize');
const models = require('../models');
const pricing = require('../helpers/pricing');
const payments = require('../helpers/payments');
const common = require('../helpers/payments/common');
const { PaymentError } = payments;
const paymentTracker = require('../helpers/paymentTracker');
const amazonHelper = require('../helpers/amazonHelper');
const { photoTakenAt } = require('../helpers/capturedAt');
const tokens = require('../helpers/tokens');
const validator = require('../helpers/validator');

const MAX_ITEMS = 50;
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

function parseIds(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = [...new Set(raw.map(Number))];
    if (!ids.length || ids.length > MAX_ITEMS || ids.some((n) => !Number.isInteger(n) || n < 1)) return null;
    return ids;
}

/**
 * Loads what the client may buy right now: media their face matched, still live, not already
 * owned. Returns { lines: [{ media, price, currency }], problems: [messages] }.
 */
async function buyableLines(clientId, mediaIds) {
    const matches = await models.client_match.findAll({
        where: { client_id: clientId, media_id: mediaIds, hidden: false },
        include: [{ model: models.media, as: 'media', where: { status: 'ready', expires_at: { [Op.gt]: new Date() } } }],
    });
    const owned = new Set((await models.purchase.findAll({
        attributes: ['media_id'],
        where: { client_id: clientId, media_id: mediaIds, download_until: { [Op.gt]: new Date() } },
        raw: true,
    })).map((p) => p.media_id));

    const problems = [];
    const found = new Set(matches.map((m) => m.media_id));
    const missing = mediaIds.filter((id) => !found.has(id));
    if (missing.length) problems.push(`${missing.length} item(s) are no longer available`);
    const already = mediaIds.filter((id) => owned.has(id));
    if (already.length) problems.push(`${already.length} item(s) are already in your purchases`);

    const usable = matches.filter((m) => !owned.has(m.media_id));
    const memberships = usable.length ? await models.event_photographer.findAll({
        where: { [Op.or]: usable.map((m) => ({ event_id: m.media.event_id, creator_id: m.media.creator_id })) },
        raw: true,
    }) : [];
    const priceOf = new Map(memberships.map((m) => [`${m.event_id}:${m.creator_id}`, m]));

    const lines = usable.map((m) => {
        const membership = priceOf.get(`${m.media.event_id}:${m.media.creator_id}`) || { price: 0, currency: pricing.CURRENCY };
        return { media: m.media, price: pricing.effectivePrice(m.media.price, membership.price), currency: membership.currency };
    });
    return { lines, problems };
}

/** Groups lines by (photographer, event) — one payment each, through that photographer's gateway. */
async function groupLines(lines) {
    const groups = new Map();
    for (const line of lines) {
        const key = `${line.media.creator_id}:${line.media.event_id}`;
        if (!groups.has(key)) groups.set(key, { creator_id: line.media.creator_id, event_id: line.media.event_id, currency: line.currency, lines: [] });
        groups.get(key).lines.push(line);
    }
    const creators = await models.user.findAll({
        where: { id: [...new Set(lines.map((l) => l.media.creator_id))] },
        attributes: ['id', 'name', 'lastname'],
        include: [{ model: models.payout_account, as: 'payout' }],
    });
    const byId = new Map(creators.map((c) => [c.id, c]));
    return [...groups.values()].map((g) => {
        const subtotal = common.round2(g.lines.reduce((s, l) => s + l.price, 0));
        const fee = common.fee(subtotal);
        const creator = byId.get(g.creator_id);
        const account = creator?.payout;
        // Prices are in the photographer's payout currency; anything else can't be charged.
        const canPay = !!account?.isReady && account.currency === g.currency;
        const provider = canPay ? payments.provider(account.provider) : null;
        return {
            creator_id: g.creator_id,
            event_id: g.event_id,
            photographer: creator ? `${creator.name} ${creator.lastname}`.trim() : '',
            trading_name: account?.display_name || null,
            can_pay: canPay,
            provider: provider?.name || null,
            provider_label: provider?.label || null,
            methods: provider ? provider.paymentMethods(account) : [],
            media_ids: g.lines.map((l) => l.media.id),
            currency: g.currency,
            subtotal,
            fee,
            total: common.round2(subtotal + fee),
            account,
        };
    });
}

const publicGroup = ({ account, ...g }) => g;

/** What the app shows while a payment is in progress. */
function nextStep(order) {
    const kind = order.redirect_url ? 'redirect' : order.payment_code ? 'code' : 'prompt';
    const total = `${order.currency} ${Number(order.total).toFixed(2)}`;
    return {
        kind,
        payment_code: order.payment_code,
        redirect_url: order.redirect_url,
        message: kind === 'prompt' ? `Approve the ${order.wallet} prompt on ${order.payer_mobile} to pay ${total}.`
            : kind === 'code' ? `Open ${order.wallet} and pay ${total} with code ${order.payment_code}.`
                : 'Complete the payment on the secure payment page.',
    };
}

// POST /api/client/checkout/quote  { media_ids }
exports.Quote = async (req, res) => {
    try {
        const ids = parseIds(req.body.media_ids);
        if (!ids) return res.status(400).json({ message: `Choose between 1 and ${MAX_ITEMS} items` });
        const { lines, problems } = await buyableLines(req.dbUser.id, ids);
        return res.status(200).json({
            groups: (await groupLines(lines)).map(publicGroup),
            problems,
            fee: { percent: Number(process.env.PLATFORM_FEE_PERCENT || 0), fixed: Number(process.env.PLATFORM_FEE_FIXED || 0) },
        });
    } catch (error) {
        console.error('Quote Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /api/client/checkout  { media_ids, method, payer_mobile?, email? }
// All items must belong to one photographer and one event (one payment).
// Guests must send `email` — the download links are emailed there (saved as contact_email).
exports.Checkout = async (req, res) => {
    let order = null;
    try {
        const ids = parseIds(req.body.media_ids);
        if (!ids) return res.status(400).json({ message: `Choose between 1 and ${MAX_ITEMS} items` });
        const methodId = String(req.body.method || '').toUpperCase();
        const payerMobile = String(req.body.payer_mobile || '').replace(/\s/g, '');
        if (req.dbUser.is_guest) {
            const email = validator.normalizeEmail(req.body.email);
            if (!validator.isValidEmail(email)) {
                return res.status(400).json({ code: 'EMAIL_REQUIRED', message: 'Enter your email so we can send you the download links' });
            }
            if (req.dbUser.contact_email !== email) await req.dbUser.update({ contact_email: email });
        }

        const { lines, problems } = await buyableLines(req.dbUser.id, ids);
        if (problems.length || lines.length !== ids.length) {
            return res.status(409).json({ code: 'CART_CHANGED', message: problems.join('. ') || 'Your cart changed. Please review it.' });
        }
        const [group, ...others] = await groupLines(lines);
        if (others.length) {
            return res.status(400).json({ code: 'MULTIPLE_PHOTOGRAPHERS', message: 'Pay for each photographer separately.' });
        }
        const free = group.total <= 0;
        if (!free && !group.can_pay) {
            return res.status(409).json({ code: 'NOT_READY', message: 'This photographer can’t receive payments yet.' });
        }
        const provider = group.can_pay ? payments.provider(group.provider) : null;
        const method = group.methods.find((m) => m.id === methodId);
        if (!free) {
            if (!method) return res.status(400).json({ message: 'Choose a payment method' });
            const problem = provider.checkMethodInput(methodId, { payerMobile });
            if (problem) return res.status(400).json({ message: problem });
        }

        // Don't charge twice: a still-pending payment for exactly these items is returned as is.
        if (!free) {
            const recent = await models.order.findAll({
                where: { client_id: req.dbUser.id, creator_id: group.creator_id, status: 'PENDING', provider: provider.name, wallet: method.wallet },
                include: [{ model: models.order_item, as: 'items', attributes: ['media_id'] }],
            });
            const sameItems = recent.find((o) => o.items.length === ids.length && o.items.every((i) => ids.includes(i.media_id)));
            if (sameItems) {
                return res.status(200).json({ order: sameItems.toPublicJSON(), next: nextStep(sameItems), existing: true });
            }
        }

        order = await models.sequelize.transaction(async (transaction) => {
            const created = await models.order.create({
                reference: common.reference(),
                client_id: req.dbUser.id,
                creator_id: group.creator_id,
                event_id: group.event_id,
                provider: free ? 'free' : provider.name,
                wallet: free ? 'FREE' : method.wallet, // short name of the rail, e.g. EcoCash, Paystack
                payer_mobile: method?.needs_mobile ? payerMobile : null,
                currency: group.currency,
                subtotal: group.subtotal,
                fee: group.fee,
                total: group.total,
                status: 'PENDING',
            }, { transaction });
            await models.order_item.bulkCreate(
                lines.map((l) => ({ order_id: created.id, media_id: l.media.id, price: l.price })),
                { transaction }
            );
            return created;
        });

        if (free) {
            await paymentTracker.markPaid(order, 'FREE');
            await order.reload();
            return res.status(201).json({ order: order.toPublicJSON(), next: { kind: 'none', message: 'These items are free — they are in your purchases.' } });
        }

        const init = await provider.createPayment({
            account: group.account,
            order,
            methodId,
            payer: { name: `${req.dbUser.name} ${req.dbUser.lastname}`.trim(), email: req.dbUser.noticeEmail, mobile: payerMobile },
            itemCount: lines.length,
        });
        await order.update({
            payment_code: init.payment_code || null,
            redirect_url: init.redirect_url || null,
            provider_status: init.provider_status || null,
        });
        return res.status(201).json({ order: order.toPublicJSON(), next: { kind: init.kind, payment_code: init.payment_code || null, redirect_url: init.redirect_url || null, message: init.message } });
    } catch (error) {
        if (order) await order.update({ status: 'FAILED' }).catch(() => {});
        if (error instanceof PaymentError) {
            return res.status(error.httpStatus()).json({ code: error.code, message: error.message });
        }
        console.error('Checkout Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /api/payments/:provider/webhook — signed gateway notifications (raw body kept by app.js).
exports.Webhook = async (req, res) => {
    let provider;
    try { provider = payments.provider(req.params.provider); } catch { return res.status(404).json({ message: 'Not found' }); }
    if (!provider.webhook) return res.status(404).json({ message: 'Not found' });
    try {
        const results = await provider.webhook(req);
        // Answer fast; verification with the gateway happens in the background.
        paymentTracker.applyWebhook(provider.name, results).catch((e) => console.error('[payments] webhook apply failed:', e.message));
        return res.status(200).json({ received: true });
    } catch (error) {
        if (error instanceof PaymentError) return res.status(error.httpStatus()).json({ message: error.message });
        console.error('Webhook Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/payments/:provider/return — where hosted checkout pages send the client back.
// The app's WebView watches for this URL and closes; in a browser it says what to do.
exports.ReturnPage = (req, res) => {
    res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:48px 24px">'
        + '<h2>Payment submitted</h2><p>You can return to the app — your photos appear in Purchases once the payment is confirmed.</p></body>');
};

// GET /api/client/orders/:id — status; checks the gateway right away while pending.
exports.OrderStatus = async (req, res) => {
    try {
        let order = await models.order.findOne({
            where: { id: req.params.id, client_id: req.dbUser.id },
            include: [{ model: models.order_item, as: 'items', attributes: ['media_id', 'price'] }],
        });
        if (!order) return res.status(404).json({ message: 'Order not found' });
        if (order.status === 'PENDING') {
            await paymentTracker.checkOrder(order);
            order = await order.reload({ include: [{ model: models.order_item, as: 'items', attributes: ['media_id', 'price'] }] });
        }
        return res.status(200).json({ order: { ...order.toPublicJSON(), media_ids: order.items.map((i) => i.media_id) } });
    } catch (error) {
        console.error('OrderStatus Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/client/orders
exports.MyOrders = async (req, res) => {
    const orders = await models.order.findAll({
        where: { client_id: req.dbUser.id },
        include: [
            { model: models.order_item, as: 'items', attributes: ['media_id'] },
            { model: models.event, as: 'event', attributes: ['id', 'name'] },
        ],
        order: [['created_at', 'DESC']],
        limit: 50,
    });
    return res.status(200).json({
        orders: orders.map((o) => ({ ...o.toPublicJSON(), event: o.event ? { id: o.event.id, name: o.event.name } : null })),
    });
};

// GET /api/client/purchases — media the client owns (full quality), newest first.
exports.MyPurchases = async (req, res) => {
    try {
        const rows = await models.purchase.findAll({
            where: { client_id: req.dbUser.id, download_until: { [Op.gt]: new Date() } },
            include: [{
                model: models.media,
                as: 'media',
                where: { status: { [Op.ne]: 'deleted' } },
                include: [
                    { model: models.event, as: 'event', attributes: ['id', 'name', 'start_date'] },
                    { model: models.user, as: 'creator', attributes: ['name', 'lastname'] },
                ],
            }],
            order: [['created_at', 'DESC']],
        });
        const purchases = await Promise.all(rows.map(async (p) => ({
            media_id: p.media_id,
            type: p.media.type,
            width: p.media.width,
            height: p.media.height,
            duration_seconds: p.media.duration_seconds,
            size_bytes: Number(p.media.size_bytes),
            // Owners see the clean thumbnail.
            thumb_url: await amazonHelper.presignDownload(p.media.thumb_key),
            event: { id: p.media.event.id, name: p.media.event.name, start_date: p.media.event.start_date },
            photographer: `${p.media.creator.name} ${p.media.creator.lastname}`.trim(),
            purchased_at: p.created_at,
            download_until: p.download_until,
        })));
        return res.status(200).json({ purchases });
    } catch (error) {
        console.error('MyPurchases Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

function downloadFilename(media) {
    const ext = path.extname(media.original_key) || (media.type === 'video' ? '.mp4' : '.jpg');
    return `smatsnap-${media.event_id}-${media.id}${ext}`;
}

// GET /api/downloads/:token — the link in the "payment received" email (no sign-in, so guests
// can download from any device). Redirects to a short-lived link to the original file.
exports.EmailDownload = async (req, res) => {
    const page = (status, heading, text) => res.status(status).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<body style="font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:48px 24px">'
        + `<h2>${heading}</h2><p>${text}</p></body>`);
    let claims;
    try {
        claims = tokens.verify(req.params.token, tokens.PURPOSE.DOWNLOAD);
    } catch (err) {
        return page(410, 'This link has expired', 'The download period for this purchase has ended, or the link is incomplete.');
    }
    try {
        const p = await models.purchase.findOne({
            where: { id: claims.pid, client_id: claims.cid, download_until: { [Op.gt]: new Date() } },
            include: [{ model: models.media, as: 'media', where: { status: { [Op.ne]: 'deleted' } } }],
        });
        if (!p) return page(404, 'Download not available', 'This item was removed or its download period has ended.');
        const url = await amazonHelper.presignDownload(p.media.original_key, { filename: downloadFilename(p.media), expiresIn: DOWNLOAD_URL_TTL_SECONDS });
        return res.redirect(302, url);
    } catch (error) {
        console.error('EmailDownload Error:', error);
        return page(500, 'Something went wrong', 'Please try the link again in a moment.');
    }
};

// GET /api/client/purchases/:mediaId/download — short-lived link to the original file.
exports.Download = async (req, res) => {
    try {
        const p = await models.purchase.findOne({
            where: { client_id: req.dbUser.id, media_id: req.params.mediaId, download_until: { [Op.gt]: new Date() } },
            include: [{ model: models.media, as: 'media', where: { status: { [Op.ne]: 'deleted' } } }],
        });
        if (!p) return res.status(404).json({ message: 'Purchase not found or download period has ended' });
        // Older uploads predate capture dates: read it once from the original and keep it.
        if (p.media.taken_at === null && p.media.type === 'photo') {
            await p.media.update({ taken_at: await photoTakenAt(await amazonHelper.getBuffer(p.media.original_key)) });
        }
        const filename = downloadFilename(p.media);
        return res.status(200).json({
            url: await amazonHelper.presignDownload(p.media.original_key, { filename, expiresIn: DOWNLOAD_URL_TTL_SECONDS }),
            filename,
            mime_type: p.media.mime_type,
            size_bytes: Number(p.media.size_bytes),
            // Galleries file the saved copy under this date (empty: unknown → "today").
            taken_at: p.media.taken_at || null,
            expires_in: DOWNLOAD_URL_TTL_SECONDS,
        });
    } catch (error) {
        console.error('Download Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
