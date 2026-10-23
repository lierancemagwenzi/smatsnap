// Follows pending payments with their gateway until they settle (tese polls every 10 s; so do
// we), and grants download rights when an order is paid. Also used on demand when the app asks
// for status, and by gateway webhooks.
const { Op } = require('sequelize');
const payments = require('./payments');
const common = require('./payments/common');
const mailer = require('./mailer');
const tokens = require('./tokens');

const MIN_CHECK_INTERVAL_MS = 3000;
let running = false;

const models = () => require('../models');

function providerLabel(name) {
    try { return payments.provider(name).label; } catch { return 'payout'; }
}

/** One emailed link per purchased item (GET /api/downloads/:token); none without API_PUBLIC_URL. */
async function downloadLinks(order) {
    const base = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!base) return [];
    const rows = await models().purchase.findAll({
        where: { order_id: order.id, client_id: order.client_id },
        include: [{ model: models().media, as: 'media', attributes: ['type'] }],
        order: [['id', 'ASC']],
    });
    let photos = 0;
    let videos = 0;
    return rows.map((p) => ({
        label: p.media?.type === 'video' ? `Download video ${++videos}` : `Download photo ${++photos}`,
        url: `${base}/api/downloads/${tokens.signDownload(p)}`,
    }));
}

/** Marks an order paid (once) and creates the client's purchases. */
async function markPaid(order, providerStatus) {
    const { order: Order, order_item, purchase, user, sequelize } = models();
    const downloadUntil = new Date(Date.now() + common.downloadDays() * 24 * 60 * 60 * 1000);
    const granted = await sequelize.transaction(async (transaction) => {
        const [updated] = await Order.update(
            { status: 'PAID', provider_status: providerStatus, paid_at: new Date(), last_checked_at: new Date() },
            // EXPIRED too: a client may finish paying after our 30-minute window.
            { where: { id: order.id, status: ['PENDING', 'EXPIRED'] }, transaction }
        );
        if (!updated) return false; // already handled by another check
        const items = await order_item.findAll({ where: { order_id: order.id }, transaction });
        for (const item of items) {
            const [row, created] = await purchase.findOrCreate({
                where: { client_id: order.client_id, media_id: item.media_id },
                defaults: { order_id: order.id, download_until: downloadUntil },
                transaction,
            });
            if (!created) await row.update({ order_id: order.id, download_until: downloadUntil }, { transaction });
        }
        return items.length;
    });
    if (!granted) return;

    const [client, creator] = await Promise.all([user.findByPk(order.client_id), user.findByPk(order.creator_id)]);
    const amount = `${order.currency} ${Number(order.total).toFixed(2)}`;
    if (client?.noticeEmail) {
        mailer.SendNotice(client.noticeEmail, 'Payment received', 'Your photos are ready to download', [
            `We received your payment of ${amount} (ref ${order.reference}).`,
            `${granted} item${granted === 1 ? ' is' : 's are'} now in Purchases in the app, in full quality and without watermarks.`,
            `Download within ${common.downloadDays()} days — in the app, or with the links below.`,
        ], await downloadLinks(order));
    }
    if (creator) {
        mailer.SendNotice(creator.email, 'You made a sale', 'New sale', [
            `A client bought ${granted} of your photos/videos for ${order.currency} ${Number(order.subtotal).toFixed(2)}.`,
            `Reference ${order.reference}. The payment went to your ${providerLabel(order.provider)} payout account.`,
        ]);
    }
}

/** Applies a gateway result ({ status: PAID|FAILED|CANCELLED|null, provider_status }) to an order. */
async function applyResult(order, { status: next, provider_status: providerStatus = null }) {

    if (next === 'PAID') {
        await markPaid(order, providerStatus);
    } else if (next) {
        await models().order.update(
            { status: next, provider_status: providerStatus, last_checked_at: new Date() },
            { where: { id: order.id, status: ['PENDING', 'EXPIRED'] } }
        );
    } else if (order.status === 'EXPIRED') {
        await models().order.update({ provider_status: providerStatus, last_checked_at: new Date() }, { where: { id: order.id } });
    } else {
        const ageMin = (Date.now() - new Date(order.created_at).getTime()) / 60000;
        const expired = ageMin > common.PENDING_TIMEOUT_MINUTES;
        await models().order.update(
            { status: expired ? 'EXPIRED' : 'PENDING', provider_status: providerStatus, last_checked_at: new Date() },
            { where: { id: order.id, status: 'PENDING' } }
        );
    }
    return order.reload();
}

/** Checks one pending order with its gateway and applies the result. Returns the fresh order. */
async function checkOrder(order, { force = false } = {}) {
    if (order.status !== 'PENDING' && order.status !== 'EXPIRED') return order;
    const last = order.last_checked_at ? new Date(order.last_checked_at).getTime() : 0;
    if (!force && Date.now() - last < MIN_CHECK_INTERVAL_MS) return order;

    let result = { status: null, provider_status: order.provider_status };
    try {
        const account = await payments.accountOf(order.creator_id);
        result = await payments.provider(order.provider || 'smatpay').checkPayment(order, account);
    } catch (err) {
        console.error(`[payments] tracking ${order.reference} failed:`, err.message);
    }
    return applyResult(order, result);
}

/**
 * A gateway webhook named these references ([{ reference }]): verify each with the gateway
 * (never just trust the notification) and apply.
 */
async function applyWebhook(providerName, results) {
    for (const r of results) {
        const order = await models().order.findOne({ where: { reference: r.reference, provider: providerName } });
        if (order) await checkOrder(order, { force: true });
    }
}

/** Scheduled every 10 s from app.js. */
async function checkPendingOrders() {
    if (running) return;
    running = true;
    try {
        const pending = await models().order.findAll({
            where: { status: 'PENDING' },
            order: [['created_at', 'ASC']],
            limit: 50,
        });
        for (const order of pending) await checkOrder(order);

        // Late payments: keep an eye on expired orders for a day, every 5 minutes.
        const lateCheck = await models().order.findAll({
            where: {
                status: 'EXPIRED',
                created_at: { [Op.gt]: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                last_checked_at: { [Op.lt]: new Date(Date.now() - 5 * 60 * 1000) },
            },
            limit: 20,
        });
        for (const order of lateCheck) await checkOrder(order, { force: true });
    } catch (err) {
        console.error('[payments] checkPendingOrders error:', err.message);
    } finally {
        running = false;
    }
}

module.exports = { checkOrder, checkPendingOrders, markPaid, applyWebhook };

// Exported for the expiry job: media with downloads still owed to buyers.
module.exports.activePurchaseMediaIds = async (mediaIds) => {
    if (!mediaIds.length) return new Set();
    const rows = await models().purchase.findAll({
        attributes: ['media_id'],
        where: { media_id: mediaIds, download_until: { [Op.gt]: new Date() } },
        raw: true,
    });
    return new Set(rows.map((r) => r.media_id));
};
