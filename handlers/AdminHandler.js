// Admin dashboard (photo-admin/). Admins are users with user_type 'admin'; 'super_admin' also
// manages other admins. Everything an admin changes is written to admin_actions.
// Contract: docs/admin-api.md.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const models = require('../models');
const tokens = require('../helpers/tokens');
const validator = require('../helpers/validator');
const mailer = require('../helpers/mailer');
const env = require('../helpers/env');
const payments = require('../helpers/payments');
const { routes: paymentRoutes } = require('../helpers/payments/countries');
const paymentTracker = require('../helpers/paymentTracker');
const mediaProcessor = require('../helpers/mediaProcessor');
const amazonHelper = require('../helpers/amazonHelper');

const ADMIN_ROLES = ['super_admin', 'admin'];
const USER_STATUSES = ['active', 'suspended'];
const EVENT_STATUSES = ['active', 'hidden'];
const ORDER_STATUSES = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED'];
const LIVE_MEDIA_STATUSES = ['uploaded', 'processing', 'ready', 'failed'];
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function fail(res, where, error) {
    console.error(`Admin ${where} Error:`, error);
    return res.status(500).json({ message: 'Internal server error' });
}

function paging(req, defaultSize = 20) {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, Number.parseInt(req.query.size, 10) || defaultSize));
    return { page, size, offset: (page - 1) * size };
}

function likeTerm(q) {
    const s = String(q || '').trim().slice(0, 100);
    return s ? `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

function intOrNull(value) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

const fullName = (u) => (u ? `${u.name || ''} ${u.lastname || ''}`.trim() : null);
const toNumber = (v) => Number(v || 0);

async function audit(req, action, targetType, targetId, details) {
    try {
        await models.admin_action.create({
            admin_id: req.dbUser.id, action, target_type: targetType, target_id: targetId, details: details || null,
        });
    } catch (err) {
        console.error('[admin] audit failed:', err.message);
    }
}

function userJSON(u) {
    return {
        ...u.toPublicJSON(),
        admin_role: u.user_type === 'admin' ? u.admin_role : undefined,
        last_login_at: u.last_login_at,
        face_consent_at: u.face_consent_at,
        created_at: u.createdAt,
    };
}

function payoutJSON(account) {
    if (!account) return null;
    let label = account.provider;
    try { label = payments.provider(account.provider).label; } catch { /* gateway removed */ }
    const d = account.detailsJSON();
    return {
        ...account.toPublicJSON(),
        provider_label: label,
        summary: [d.bank_name, d.account_last4 ? `••••${d.account_last4}` : null, d.phone].filter(Boolean).join(' · ') || null,
        created_at: account.createdAt,
    };
}

function orderJSON(o, itemCount) {
    return {
        id: o.id,
        reference: o.reference,
        status: o.status,
        provider: o.provider,
        method: o.wallet,
        currency: o.currency,
        subtotal: toNumber(o.subtotal),
        fee: toNumber(o.fee),
        total: toNumber(o.total),
        provider_status: o.provider_status,
        created_at: o.createdAt,
        paid_at: o.paid_at,
        last_checked_at: o.last_checked_at,
        item_count: itemCount,
        event: o.event ? { id: o.event.id, name: o.event.name } : null,
        creator: o.creator ? { id: o.creator.id, name: fullName(o.creator), email: o.creator.email } : null,
        client: o.client ? { id: o.client.id, name: fullName(o.client), email: o.client.email } : null,
    };
}

async function itemCounts(orderIds) {
    if (!orderIds.length) return new Map();
    const rows = await models.order_item.findAll({
        attributes: ['order_id', [fn('COUNT', col('id')), 'n']],
        where: { order_id: orderIds },
        group: ['order_id'],
        raw: true,
    });
    return new Map(rows.map((r) => [r.order_id, Number(r.n)]));
}

/** Sums of paid orders per currency: [{ currency, gross, fees, earnings, orders }]. */
async function paidTotals(where = {}) {
    const rows = await models.order.findAll({
        attributes: [
            'currency',
            [fn('SUM', col('total')), 'gross'],
            [fn('SUM', col('fee')), 'fees'],
            [fn('SUM', col('subtotal')), 'earnings'],
            [fn('COUNT', col('id')), 'orders'],
        ],
        where: { ...where, status: 'PAID' },
        group: ['currency'],
        raw: true,
    });
    return rows.map((r) => ({
        currency: r.currency, gross: toNumber(r.gross), fees: toNumber(r.fees), earnings: toNumber(r.earnings), orders: toNumber(r.orders),
    }));
}

const countBy = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], toNumber(r.n)]));

// ── Auth ────────────────────────────────────────────────────────────────────

// POST /api/admin/auth/login { email, password } — admins only. Refresh/logout/forgot-password
// use the shared /api/auth endpoints.
exports.Login = async (req, res) => {
    try {
        const email = validator.normalizeEmail(req.body.email);
        const { password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

        const existing = await models.user.findOne({ where: { email } });
        const isMatch = await bcrypt.compare(String(password), existing ? existing.password : DUMMY_HASH);
        if (!existing || !isMatch || existing.user_type !== 'admin') {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        if (existing.status !== 'active') return res.status(403).json({ message: 'This admin account has been deactivated' });
        if (!existing.email_verified_at) {
            return res.status(403).json({ code: 'PASSWORD_NOT_SET', message: 'Set your password first using “Set or reset password”.' });
        }
        const session = await tokens.issueSession(existing);
        return res.status(200).json({ message: 'Login successful', ...session, user: existing.toPublicJSON() });
    } catch (error) {
        return fail(res, 'Login', error);
    }
};

// ── Overview ────────────────────────────────────────────────────────────────

// GET /api/admin/stats?days=30
exports.Stats = async (req, res) => {
    try {
        const days = Math.min(365, Math.max(7, Number.parseInt(req.query.days, 10) || 30));
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCDate(since.getUTCDate() - (days - 1));
        const now = new Date();
        const liveMedia = { status: LIVE_MEDIA_STATUSES, expires_at: { [Op.gt]: now } };
        const q = (sql, replacements) => models.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

        const [
            usersByType, newUsers, activeUsers30, eventsByStatus, liveEvents, newEvents,
            mediaByType, mediaQueue, ordersByStatus, totals, totalsPeriod, purchases, searches,
            payoutRows, signupSeries, salesSeries, topEvents, topPhotographers,
        ] = await Promise.all([
            q(`SELECT user_type, status, COUNT(*) n FROM users GROUP BY user_type, status`),
            q(`SELECT user_type, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY user_type`, [since]),
            q(`SELECT COUNT(*) n FROM users WHERE last_login_at >= ? AND user_type <> 'admin'`, [since]),
            q(`SELECT status, COUNT(*) n FROM events GROUP BY status`),
            models.media.count({ where: liveMedia, distinct: true, col: 'event_id' }),
            models.event.count({ where: { created_at: { [Op.gte]: since } } }),
            models.media.findAll({
                attributes: ['type', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('size_bytes')), 'bytes']],
                where: liveMedia, group: ['type'], raw: true,
            }),
            q(`SELECT status, COUNT(*) n FROM media WHERE status IN ('pending','uploaded','processing','failed') GROUP BY status`),
            q(`SELECT status, COUNT(*) n FROM orders GROUP BY status`),
            paidTotals(),
            paidTotals({ paid_at: { [Op.gte]: since } }),
            models.purchase.count(),
            models.client_event.count(),
            q(`SELECT provider, status, COUNT(*) n FROM payout_accounts GROUP BY provider, status`),
            q(`SELECT DATE(created_at) d, user_type, COUNT(*) n FROM users
               WHERE created_at >= ? AND user_type <> 'admin' GROUP BY d, user_type ORDER BY d`, [since]),
            q(`SELECT DATE(paid_at) d, currency, SUM(total) gross, SUM(fee) fees, COUNT(*) n FROM orders
               WHERE status = 'PAID' AND paid_at >= ? GROUP BY d, currency ORDER BY d`, [since]),
            q(`SELECT e.id, e.name, e.code, o.currency, COUNT(o.id) orders, SUM(o.total) gross FROM orders o
               JOIN events e ON e.id = o.event_id WHERE o.status = 'PAID'
               GROUP BY e.id, e.name, e.code, o.currency ORDER BY orders DESC, gross DESC LIMIT 5`),
            q(`SELECT u.id, u.name, u.lastname, o.currency, COUNT(o.id) orders, SUM(o.subtotal) earnings FROM orders o
               JOIN users u ON u.id = o.creator_id WHERE o.status = 'PAID'
               GROUP BY u.id, u.name, u.lastname, o.currency ORDER BY orders DESC, earnings DESC LIMIT 5`),
        ]);

        const users = { total: 0, creators: 0, clients: 0, admins: 0, suspended: 0 };
        for (const r of usersByType) {
            const n = toNumber(r.n);
            if (r.user_type !== 'admin') users.total += n;
            if (r.user_type === 'creator') users.creators += n;
            if (r.user_type === 'client') users.clients += n;
            if (r.user_type === 'admin') users.admins += n;
            if (r.status !== 'active' && r.user_type !== 'admin') users.suspended += n;
        }
        const newByType = countBy(newUsers, 'user_type');

        // Day-by-day series with zero-filled gaps (dates are UTC).
        const dates = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(since);
            d.setUTCDate(d.getUTCDate() + i);
            dates.push(d.toISOString().slice(0, 10));
        }
        const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
        const signups = Object.fromEntries(dates.map((d) => [d, { date: d, creators: 0, clients: 0 }]));
        for (const r of signupSeries) {
            const row = signups[dayKey(r.d)];
            if (row) row[r.user_type === 'creator' ? 'creators' : 'clients'] += toNumber(r.n);
        }
        const currencies = [...new Set(salesSeries.map((r) => r.currency))];
        const sales = Object.fromEntries(dates.map((d) => [d, { date: d, orders: 0, gross: {}, fees: {} }]));
        for (const r of salesSeries) {
            const row = sales[dayKey(r.d)];
            if (!row) continue;
            row.orders += toNumber(r.n);
            row.gross[r.currency] = toNumber(r.gross);
            row.fees[r.currency] = toNumber(r.fees);
        }

        const payouts = { total: 0, ready: 0, by_provider: {} };
        for (const r of payoutRows) {
            const n = toNumber(r.n);
            payouts.total += n;
            if (r.status === 'ready') payouts.ready += n;
            payouts.by_provider[r.provider] = (payouts.by_provider[r.provider] || 0) + n;
        }

        return res.status(200).json({
            days,
            since: dates[0],
            users: {
                ...users,
                new_creators: newByType.creator || 0,
                new_clients: newByType.client || 0,
                active_in_period: toNumber(activeUsers30[0]?.n),
            },
            events: {
                total: Object.values(countBy(eventsByStatus, 'status')).reduce((a, b) => a + b, 0),
                by_status: countBy(eventsByStatus, 'status'),
                live: liveEvents,
                new_in_period: newEvents,
                client_searches: searches,
            },
            media: {
                live: mediaByType.reduce((a, r) => a + toNumber(r.n), 0),
                live_bytes: mediaByType.reduce((a, r) => a + toNumber(r.bytes), 0),
                by_type: Object.fromEntries(mediaByType.map((r) => [r.type, { count: toNumber(r.n), bytes: toNumber(r.bytes) }])),
                queue: countBy(mediaQueue, 'status'),
            },
            orders: {
                by_status: countBy(ordersByStatus, 'status'),
                purchases,
                totals,
                totals_in_period: totalsPeriod,
            },
            payouts,
            series: { currencies, signups: Object.values(signups), sales: Object.values(sales) },
            top_events: topEvents.map((r) => ({ id: r.id, name: r.name, code: r.code, currency: r.currency, orders: toNumber(r.orders), gross: toNumber(r.gross) })),
            top_photographers: topPhotographers.map((r) => ({ id: r.id, name: fullName(r), currency: r.currency, orders: toNumber(r.orders), earnings: toNumber(r.earnings) })),
        });
    } catch (error) {
        return fail(res, 'Stats', error);
    }
};

// GET /api/admin/system — what's configured and whether background work is keeping up.
exports.System = async (req, res) => {
    try {
        let database = { ok: true };
        try { await models.sequelize.authenticate(); } catch (err) { database = { ok: false, error: err.message }; }

        const faceProvider = (process.env.FACE_PROVIDER || 'local').toLowerCase();
        let face = { provider: faceProvider, ok: true, detail: 'AWS Rekognition (managed)' };
        if (faceProvider === 'local') {
            const url = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:8611';
            try {
                const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
                face = { provider: faceProvider, ok: r.ok, detail: r.ok ? 'Face service is running' : `Face service responded ${r.status}` };
            } catch (err) {
                face = { provider: faceProvider, ok: false, detail: `Face service unreachable (${err.message})` };
            }
        }

        const countryRoutes = paymentRoutes();
        const gateways = ['smatpay', 'paystack'].map((name) => {
            let p = null;
            try { p = payments.provider(name); } catch { /* not installed */ }
            return {
                name,
                label: p?.label || name,
                configured: !!p?.isConfigured?.(),
                test_mode: p ? payments.testMode(name) : false,
                countries: Object.entries(countryRoutes).filter(([, c]) => c.provider === name).map(([code, c]) => ({ code, name: c.name, currency: c.currency })),
            };
        });

        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [waiting, processing, failed24h, faceFailed, pendingOrders, oldestPending] = await Promise.all([
            models.media.count({ where: { status: 'uploaded' } }),
            models.media.count({ where: { status: 'processing' } }),
            models.media.count({ where: { status: 'failed', updated_at: { [Op.gte]: dayAgo } } }),
            models.media.count({ where: { status: 'ready', face_status: 'failed', expires_at: { [Op.gt]: new Date() } } }),
            models.order.count({ where: { status: 'PENDING' } }),
            models.order.findOne({ where: { status: 'PENDING' }, order: [['created_at', 'ASC']] }),
        ]);

        return res.status(200).json({
            api: {
                environment: env.isProd() ? 'production' : 'development',
                node: process.version,
                uptime_seconds: Math.round(process.uptime()),
                public_url: process.env.API_PUBLIC_URL || null,
            },
            database,
            face,
            email: { configured: !!process.env.SMTP_HOST, from: process.env.MAIL_FROM || null },
            storage: { bucket: env.s3Bucket() || null, region: env.s3BucketRegion() },
            smatpay_plane: process.env.SMATPAY_PLANE || 'sandbox',
            gateways,
            queues: {
                media_waiting: waiting,
                media_processing: processing,
                media_failed_24h: failed24h,
                face_index_failed: faceFailed,
                orders_pending: pendingOrders,
                oldest_pending_order_at: oldestPending?.createdAt || null,
            },
        });
    } catch (error) {
        return fail(res, 'System', error);
    }
};

// ── Users (clients + photographers) ─────────────────────────────────────────

// GET /api/admin/users?type=creator|client&status=&q=&page=&size=
exports.Users = async (req, res) => {
    try {
        const { page, size, offset } = paging(req);
        const where = { user_type: ['creator', 'client'].includes(req.query.type) ? req.query.type : ['creator', 'client'] };
        if (USER_STATUSES.includes(req.query.status)) where.status = req.query.status;
        if (req.query.verified === 'true') where.email_verified_at = { [Op.ne]: null };
        if (req.query.verified === 'false') where.email_verified_at = null;
        const like = likeTerm(req.query.q);
        if (like) where[Op.or] = [{ name: { [Op.like]: like } }, { lastname: { [Op.like]: like } }, { email: { [Op.like]: like } }];

        const { rows, count } = await models.user.findAndCountAll({
            where,
            include: [{ model: models.payout_account, as: 'payout', required: false }],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset,
        });
        return res.status(200).json({
            page, size, total: count,
            users: rows.map((u) => ({ ...userJSON(u), payout: payoutJSON(u.payout) })),
        });
    } catch (error) {
        return fail(res, 'Users', error);
    }
};

// GET /api/admin/users/:id
exports.UserDetail = async (req, res) => {
    try {
        const u = await models.user.findOne({
            where: { id: req.params.id, user_type: ['creator', 'client'] },
            include: [{ model: models.payout_account, as: 'payout', required: false }],
        });
        if (!u) return res.status(404).json({ message: 'User not found' });

        let stats;
        let recentOrders;
        const orderInclude = [
            { model: models.event, as: 'event', attributes: ['id', 'name'] },
            { model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname', 'email'] },
            { model: models.user, as: 'client', attributes: ['id', 'name', 'lastname', 'email'] },
        ];
        if (u.user_type === 'creator') {
            const now = new Date();
            const [events, liveMedia, totalUploads, earnings, itemsSold] = await Promise.all([
                models.event_photographer.count({ where: { creator_id: u.id } }),
                models.media.count({ where: { creator_id: u.id, status: LIVE_MEDIA_STATUSES, expires_at: { [Op.gt]: now } } }),
                models.media.count({ where: { creator_id: u.id, status: { [Op.ne]: 'pending' } } }),
                paidTotals({ creator_id: u.id }),
                models.order_item.count({ include: [{ model: models.order, as: 'order', where: { creator_id: u.id, status: 'PAID' } }] }),
            ]);
            stats = { events, live_media: liveMedia, total_uploads: totalUploads, earnings, items_sold: itemsSold };
            recentOrders = await models.order.findAll({ where: { creator_id: u.id }, include: orderInclude, order: [['created_at', 'DESC']], limit: 10 });
        } else {
            const [eventsSearched, matches, spent, purchases] = await Promise.all([
                models.client_event.count({ where: { client_id: u.id } }),
                models.client_match.count({ where: { client_id: u.id, hidden: false } }),
                paidTotals({ client_id: u.id }),
                models.purchase.count({ where: { client_id: u.id } }),
            ]);
            stats = { events_searched: eventsSearched, matches, spent, purchases };
            recentOrders = await models.order.findAll({ where: { client_id: u.id }, include: orderInclude, order: [['created_at', 'DESC']], limit: 10 });
        }
        const counts = await itemCounts(recentOrders.map((o) => o.id));

        return res.status(200).json({
            user: { ...userJSON(u), payout: payoutJSON(u.payout) },
            stats,
            recent_orders: recentOrders.map((o) => orderJSON(o, counts.get(o.id) || 0)),
        });
    } catch (error) {
        return fail(res, 'UserDetail', error);
    }
};

// PUT /api/admin/users/:id/status { status: 'active'|'suspended', reason? }
exports.SetUserStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!USER_STATUSES.includes(status)) return res.status(400).json({ message: 'Status must be active or suspended' });
        const u = await models.user.findOne({ where: { id: req.params.id, user_type: ['creator', 'client'] } });
        if (!u) return res.status(404).json({ message: 'User not found' });
        if (u.status === status) return res.status(200).json({ message: 'No change', user: userJSON(u) });

        u.status = status;
        // Suspended users are signed out everywhere (access tokens are rejected by status already).
        if (status !== 'active') u.refresh_token_hash = null;
        await u.save();
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
        await audit(req, status === 'active' ? 'user.reactivate' : 'user.suspend', 'user', u.id, { email: u.email, reason });
        return res.status(200).json({ message: status === 'active' ? 'User reactivated' : 'User suspended', user: userJSON(u) });
    } catch (error) {
        return fail(res, 'SetUserStatus', error);
    }
};

// ── Events & media ──────────────────────────────────────────────────────────

// GET /api/admin/events?status=&q=&page=&size=
exports.Events = async (req, res) => {
    try {
        const { page, size, offset } = paging(req);
        const where = {};
        if (EVENT_STATUSES.includes(req.query.status)) where.status = req.query.status;
        const like = likeTerm(req.query.q);
        if (like) {
            where[Op.or] = [
                { name: { [Op.like]: like } }, { code: { [Op.like]: like } },
                { city: { [Op.like]: like } }, { venue: { [Op.like]: like } },
            ];
        }
        const { rows, count } = await models.event.findAndCountAll({
            where,
            attributes: {
                include: [
                    [literal('(SELECT COUNT(*) FROM event_photographers ep WHERE ep.event_id = event.id)'), 'photographer_count'],
                    [literal(`(SELECT COUNT(*) FROM media m WHERE m.event_id = event.id AND m.status IN ('uploaded','processing','ready','failed') AND m.expires_at > NOW())`), 'live_media'],
                    [literal(`(SELECT COUNT(*) FROM orders o WHERE o.event_id = event.id AND o.status = 'PAID')`), 'paid_orders'],
                ],
            },
            include: [{ model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname'] }],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset,
        });
        return res.status(200).json({
            page, size, total: count,
            events: rows.map((e) => ({
                ...e.toPublicJSON(),
                created_at: e.createdAt,
                created_by: e.creator ? { id: e.creator.id, name: fullName(e.creator) } : null,
                photographer_count: toNumber(e.get('photographer_count')),
                live_media: toNumber(e.get('live_media')),
                paid_orders: toNumber(e.get('paid_orders')),
            })),
        });
    } catch (error) {
        return fail(res, 'Events', error);
    }
};

// GET /api/admin/events/:id
exports.EventDetail = async (req, res) => {
    try {
        const e = await models.event.findByPk(req.params.id, {
            include: [{ model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname', 'email'] }],
        });
        if (!e) return res.status(404).json({ message: 'Event not found' });
        const now = new Date();

        const [memberships, mediaCounts, liveByCreator, sales, searches, matches] = await Promise.all([
            models.event_photographer.findAll({
                where: { event_id: e.id },
                include: [{ model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname', 'email', 'status'] }],
                order: [['created_at', 'ASC']],
            }),
            models.media.findAll({
                attributes: ['status', [fn('COUNT', col('id')), 'n']],
                where: { event_id: e.id }, group: ['status'], raw: true,
            }),
            models.media.findAll({
                attributes: ['creator_id', [fn('COUNT', col('id')), 'n']],
                where: { event_id: e.id, status: LIVE_MEDIA_STATUSES, expires_at: { [Op.gt]: now } },
                group: ['creator_id'], raw: true,
            }),
            paidTotals({ event_id: e.id }),
            models.client_event.count({ where: { event_id: e.id } }),
            models.client_match.count({ where: { event_id: e.id } }),
        ]);
        const liveOf = new Map(liveByCreator.map((r) => [r.creator_id, toNumber(r.n)]));

        return res.status(200).json({
            event: {
                ...e.toPublicJSON(),
                created_at: e.createdAt,
                created_by: e.creator ? { id: e.creator.id, name: fullName(e.creator), email: e.creator.email } : null,
            },
            photographers: memberships.map((m) => ({
                id: m.creator_id,
                name: fullName(m.creator),
                email: m.creator?.email,
                status: m.creator?.status,
                price: toNumber(m.price),
                currency: m.currency,
                joined_at: m.createdAt,
                live_media: liveOf.get(m.creator_id) || 0,
            })),
            media_by_status: countBy(mediaCounts, 'status'),
            sales,
            client_searches: searches,
            matches,
        });
    } catch (error) {
        return fail(res, 'EventDetail', error);
    }
};

// PUT /api/admin/events/:id/status { status: 'active'|'hidden', reason? }
// Hidden events disappear from client search and can't be joined; their media stays until expiry.
exports.SetEventStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!EVENT_STATUSES.includes(status)) return res.status(400).json({ message: 'Status must be active or hidden' });
        const e = await models.event.findByPk(req.params.id);
        if (!e) return res.status(404).json({ message: 'Event not found' });
        if (e.status !== status) {
            await e.update({ status });
            const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
            await audit(req, status === 'hidden' ? 'event.hide' : 'event.show', 'event', e.id, { name: e.name, reason });
        }
        return res.status(200).json({ message: status === 'hidden' ? 'Event hidden' : 'Event visible', event: e.toPublicJSON() });
    } catch (error) {
        return fail(res, 'SetEventStatus', error);
    }
};

// GET /api/admin/events/:id/media?creator_id=&status=&type=&page=&size=
exports.EventMedia = async (req, res) => {
    try {
        const { page, size, offset } = paging(req, 30);
        const where = { event_id: req.params.id };
        where.status = ['pending', 'uploaded', 'processing', 'ready', 'failed', 'deleted'].includes(req.query.status)
            ? req.query.status : { [Op.notIn]: ['pending', 'deleted'] };
        const creatorId = intOrNull(req.query.creator_id);
        if (creatorId) where.creator_id = creatorId;
        if (['photo', 'video'].includes(req.query.type)) where.type = req.query.type;

        const { rows, count } = await models.media.findAndCountAll({
            where,
            include: [{ model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname'] }],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset,
        });
        const sold = rows.length ? await models.order_item.findAll({
            attributes: ['media_id', [fn('COUNT', col('order_item.id')), 'n']],
            where: { media_id: rows.map((m) => m.id) },
            include: [{ model: models.order, as: 'order', attributes: [], where: { status: 'PAID' } }],
            group: ['media_id'],
            raw: true,
        }) : [];
        const soldOf = new Map(sold.map((r) => [r.media_id, toNumber(r.n)]));

        const media = await Promise.all(rows.map(async (m) => ({
            id: m.id,
            type: m.type,
            status: m.status,
            filename: m.filename,
            size_bytes: toNumber(m.size_bytes),
            width: m.width,
            height: m.height,
            duration_seconds: m.duration_seconds,
            price: m.price === null ? null : toNumber(m.price),
            face_status: m.face_status,
            face_count: m.face_count,
            error: m.status === 'failed' ? m.error : null,
            uploaded_at: m.uploaded_at,
            expires_at: m.expires_at,
            sold: soldOf.get(m.id) || 0,
            creator: m.creator ? { id: m.creator.id, name: fullName(m.creator) } : null,
            // The watermarked preview is enough for moderation; originals stay with the buyer/photographer.
            thumb_url: m.status === 'deleted' ? null : await amazonHelper.presignDownload(m.preview_thumb_key || m.thumb_key),
            preview_url: m.status === 'deleted' ? null : await amazonHelper.presignDownload(m.preview_key || m.thumb_key),
        })));
        return res.status(200).json({ page, size, total: count, media });
    } catch (error) {
        return fail(res, 'EventMedia', error);
    }
};

// DELETE /api/admin/media/:id?force=true { reason? } — takes media down (files + face data).
// Media with an active purchase needs force=true: its buyers lose their download.
exports.DeleteMedia = async (req, res) => {
    try {
        const item = await models.media.findByPk(req.params.id);
        if (!item || item.status === 'deleted') return res.status(404).json({ message: 'Media not found' });
        const owed = await paymentTracker.activePurchaseMediaIds([item.id]);
        if (owed.has(item.id) && req.query.force !== 'true') {
            return res.status(409).json({
                code: 'PURCHASED',
                message: 'Clients bought this item and can still download it. Delete anyway to remove their access too.',
            });
        }
        await mediaProcessor.purge([item]);
        await item.update({ status: 'deleted', upload_id: null, face_count: 0 });
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;
        await audit(req, 'media.delete', 'media', item.id, {
            event_id: item.event_id, creator_id: item.creator_id, filename: item.filename, purchased: owed.has(item.id), reason,
        });
        return res.status(200).json({ message: 'Media deleted' });
    } catch (error) {
        return fail(res, 'DeleteMedia', error);
    }
};

// ── Orders & payouts ────────────────────────────────────────────────────────

// GET /api/admin/orders?status=&provider=&currency=&q=&event_id=&creator_id=&client_id=&from=&to=&page=&size=
exports.Orders = async (req, res) => {
    try {
        const { page, size, offset } = paging(req);
        const where = {};
        if (ORDER_STATUSES.includes(req.query.status)) where.status = req.query.status;
        if (typeof req.query.provider === 'string' && req.query.provider) where.provider = req.query.provider;
        if (typeof req.query.currency === 'string' && req.query.currency) where.currency = req.query.currency.toUpperCase();
        for (const key of ['event_id', 'creator_id', 'client_id']) {
            const id = intOrNull(req.query[key]);
            if (id) where[key] = id;
        }
        const range = {};
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) range[Op.gte] = new Date(`${req.query.from}T00:00:00Z`);
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) range[Op.lt] = new Date(new Date(`${req.query.to}T00:00:00Z`).getTime() + 86400000);
        if (Object.getOwnPropertySymbols(range).length) where.created_at = range;
        const like = likeTerm(req.query.q);
        if (like) where[Op.or] = [{ reference: { [Op.like]: like } }, { payment_code: { [Op.like]: like } }];

        const { rows, count } = await models.order.findAndCountAll({
            where,
            include: [
                { model: models.event, as: 'event', attributes: ['id', 'name'] },
                { model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname', 'email'] },
                { model: models.user, as: 'client', attributes: ['id', 'name', 'lastname', 'email'] },
            ],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset,
        });
        const counts = await itemCounts(rows.map((o) => o.id));
        const providers = (await models.order.findAll({ attributes: [[fn('DISTINCT', col('provider')), 'provider']], raw: true })).map((r) => r.provider);
        const currencies = (await models.order.findAll({ attributes: [[fn('DISTINCT', col('currency')), 'currency']], raw: true })).map((r) => r.currency);
        return res.status(200).json({
            page, size, total: count,
            filters: { providers, currencies, statuses: ORDER_STATUSES },
            orders: rows.map((o) => orderJSON(o, counts.get(o.id) || 0)),
        });
    } catch (error) {
        return fail(res, 'Orders', error);
    }
};

// GET /api/admin/orders/:id
exports.OrderDetail = async (req, res) => {
    try {
        const o = await models.order.findByPk(req.params.id, {
            include: [
                { model: models.event, as: 'event', attributes: ['id', 'name'] },
                { model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname', 'email'] },
                { model: models.user, as: 'client', attributes: ['id', 'name', 'lastname', 'email'] },
                { model: models.order_item, as: 'items', include: [{ model: models.media, as: 'media' }] },
            ],
        });
        if (!o) return res.status(404).json({ message: 'Order not found' });
        const purchases = await models.purchase.findAll({ where: { order_id: o.id }, raw: true });
        const purchaseOf = new Map(purchases.map((p) => [p.media_id, p]));
        const items = await Promise.all(o.items.map(async (it) => ({
            media_id: it.media_id,
            price: toNumber(it.price),
            type: it.media?.type,
            filename: it.media?.filename,
            media_status: it.media?.status,
            thumb_url: it.media && it.media.status !== 'deleted'
                ? await amazonHelper.presignDownload(it.media.preview_thumb_key || it.media.thumb_key) : null,
            download_until: purchaseOf.get(it.media_id)?.download_until || null,
        })));
        return res.status(200).json({ order: { ...orderJSON(o, items.length), payment_code: o.payment_code, payer_mobile: o.payer_mobile }, items });
    } catch (error) {
        return fail(res, 'OrderDetail', error);
    }
};

// POST /api/admin/orders/:id/recheck — asks the gateway again (pending/expired orders only).
exports.RecheckOrder = async (req, res) => {
    try {
        const o = await models.order.findByPk(req.params.id);
        if (!o) return res.status(404).json({ message: 'Order not found' });
        if (!['PENDING', 'EXPIRED'].includes(o.status)) {
            return res.status(400).json({ message: `This order is already ${o.status.toLowerCase()}` });
        }
        const before = o.status;
        const fresh = await paymentTracker.checkOrder(o, { force: true });
        await audit(req, 'order.recheck', 'order', o.id, { reference: o.reference, before, after: fresh.status });
        return res.status(200).json({
            message: fresh.status === before ? `Still ${fresh.status.toLowerCase()} with the gateway` : `Order is now ${fresh.status.toLowerCase()}`,
            status: fresh.status,
            provider_status: fresh.provider_status,
        });
    } catch (error) {
        return fail(res, 'RecheckOrder', error);
    }
};

// GET /api/admin/payouts?provider=&status=&country=&q=&page=&size=
exports.Payouts = async (req, res) => {
    try {
        const { page, size, offset } = paging(req);
        const where = {};
        for (const key of ['provider', 'status', 'country']) {
            if (typeof req.query[key] === 'string' && req.query[key]) where[key] = req.query[key];
        }
        const like = likeTerm(req.query.q);
        if (like) where[Op.or] = [{ display_name: { [Op.like]: like } }, { external_id: { [Op.like]: like } }, { '$user.email$': { [Op.like]: like } }, { '$user.name$': { [Op.like]: like } }, { '$user.lastname$': { [Op.like]: like } }];

        const { rows, count } = await models.payout_account.findAndCountAll({
            where,
            include: [{ model: models.user, as: 'user', attributes: ['id', 'name', 'lastname', 'email', 'status'], required: !!like }],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset,
            subQuery: false,
        });
        const earnings = rows.length ? await models.order.findAll({
            attributes: ['creator_id', 'currency', [fn('SUM', col('subtotal')), 'earned'], [fn('COUNT', col('id')), 'n']],
            where: { creator_id: rows.map((r) => r.user_id), status: 'PAID' },
            group: ['creator_id', 'currency'],
            raw: true,
        }) : [];
        const earnedOf = new Map();
        for (const r of earnings) {
            const list = earnedOf.get(r.creator_id) || [];
            list.push({ currency: r.currency, amount: toNumber(r.earned), orders: toNumber(r.n) });
            earnedOf.set(r.creator_id, list);
        }
        return res.status(200).json({
            page, size, total: count,
            payouts: rows.map((a) => ({
                ...payoutJSON(a),
                id: a.id,
                user: a.user ? { id: a.user.id, name: fullName(a.user), email: a.user.email, status: a.user.status } : null,
                earned: earnedOf.get(a.user_id) || [],
            })),
        });
    } catch (error) {
        return fail(res, 'Payouts', error);
    }
};

// ── Admins (super_admin only) ───────────────────────────────────────────────

function dashboardUrl() {
    return (process.env.ADMIN_DASHBOARD_URL || '').replace(/\/+$/, '') || null;
}

async function activeSuperAdmins() {
    return models.user.count({ where: { user_type: 'admin', admin_role: 'super_admin', status: 'active' } });
}

// GET /api/admin/admins
exports.Admins = async (req, res) => {
    try {
        const rows = await models.user.findAll({ where: { user_type: 'admin' }, order: [['created_at', 'ASC']] });
        return res.status(200).json({
            admins: rows.map((u) => ({ ...userJSON(u), password_set: !!u.email_verified_at, is_me: u.id === req.dbUser.id })),
        });
    } catch (error) {
        return fail(res, 'Admins', error);
    }
};

// POST /api/admin/admins { name, lastname, email, admin_role }
// The new admin chooses their own password through the forgot-password flow ("Set or reset
// password" on the dashboard); confirming that code also verifies their email.
exports.CreateAdmin = async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        const lastname = (req.body.lastname || '').trim();
        const email = validator.normalizeEmail(req.body.email);
        const role = req.body.admin_role || 'admin';
        if (!validator.isValidName(name) || !validator.isValidName(lastname)) {
            return res.status(400).json({ message: 'First name and last name are required' });
        }
        if (!validator.isValidEmail(email)) return res.status(400).json({ message: 'Enter a valid email address' });
        if (!ADMIN_ROLES.includes(role)) return res.status(400).json({ message: 'Role must be super_admin or admin' });
        if (await models.user.findOne({ where: { email } })) {
            return res.status(409).json({ message: 'An account with this email already exists' });
        }

        const created = await models.user.create({
            name, lastname, email,
            user_type: 'admin',
            admin_role: role,
            status: 'active',
            // Unusable until they set their own.
            password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
            email_verified_at: null,
            otp_attempts: 0,
        });
        const url = dashboardUrl();
        const setPasswordUrl = url ? `${url}/set-password?email=${encodeURIComponent(email)}` : null;
        await mailer.SendNotice(email, 'You’re now an admin', `Welcome to the ${env.appName()} admin team`, [
            `${fullName(req.dbUser)} added you as ${role === 'super_admin' ? 'a super admin' : 'an admin'}.`,
            setPasswordUrl
                ? `Choose your password here: <a href="${setPasswordUrl}" style="color:#e64b9b;">${setPasswordUrl}</a>`
                : 'Open the admin dashboard and choose “Set or reset password” to create your password.',
            'We’ll email you a code to confirm it’s you.',
        ]);
        await audit(req, 'admin.create', 'admin', created.id, { email, admin_role: role });
        return res.status(201).json({
            message: 'Admin added. They’ve been emailed instructions to set a password.',
            admin: { ...userJSON(created), password_set: false, is_me: false },
            set_password_url: setPasswordUrl,
        });
    } catch (error) {
        return fail(res, 'CreateAdmin', error);
    }
};

// PUT /api/admin/admins/:id { admin_role?, status? }
exports.UpdateAdmin = async (req, res) => {
    try {
        const target = await models.user.findOne({ where: { id: req.params.id, user_type: 'admin' } });
        if (!target) return res.status(404).json({ message: 'Admin not found' });
        if (target.id === req.dbUser.id) return res.status(400).json({ message: 'You can’t change your own role or status' });

        const { admin_role: role, status } = req.body;
        if (role !== undefined && !ADMIN_ROLES.includes(role)) return res.status(400).json({ message: 'Role must be super_admin or admin' });
        if (status !== undefined && !USER_STATUSES.includes(status)) return res.status(400).json({ message: 'Status must be active or suspended' });

        const losesSuper = target.admin_role === 'super_admin' && target.status === 'active'
            && ((role && role !== 'super_admin') || (status && status !== 'active'));
        if (losesSuper && (await activeSuperAdmins()) <= 1) {
            return res.status(400).json({ message: 'There must always be at least one active super admin' });
        }

        const changes = {};
        if (role && role !== target.admin_role) changes.admin_role = role;
        if (status && status !== target.status) {
            changes.status = status;
            if (status !== 'active') changes.refresh_token_hash = null;
        }
        if (!Object.keys(changes).length) return res.status(200).json({ message: 'No change', admin: userJSON(target) });

        const before = { admin_role: target.admin_role, status: target.status };
        await target.update(changes);
        await audit(req, 'admin.update', 'admin', target.id, {
            email: target.email, before, after: { admin_role: target.admin_role, status: target.status },
        });
        return res.status(200).json({ message: 'Admin updated', admin: { ...userJSON(target), password_set: !!target.email_verified_at, is_me: false } });
    } catch (error) {
        return fail(res, 'UpdateAdmin', error);
    }
};

// DELETE /api/admin/admins/:id — removes an admin who never set a password (a mistyped invite).
// Admins who have used the dashboard are suspended instead, so the audit log keeps its authors.
exports.DeleteAdmin = async (req, res) => {
    try {
        const target = await models.user.findOne({ where: { id: req.params.id, user_type: 'admin' } });
        if (!target) return res.status(404).json({ message: 'Admin not found' });
        if (target.id === req.dbUser.id) return res.status(400).json({ message: 'You can’t remove yourself' });
        if (target.email_verified_at) {
            return res.status(400).json({ message: 'This admin has already signed in — suspend them instead' });
        }
        await audit(req, 'admin.remove_invite', 'admin', target.id, { email: target.email });
        await target.destroy();
        return res.status(200).json({ message: 'Invite removed' });
    } catch (error) {
        return fail(res, 'DeleteAdmin', error);
    }
};

// ── Activity log ────────────────────────────────────────────────────────────

// GET /api/admin/activity?admin_id=&target_type=&target_id=&page=&size=
exports.Activity = async (req, res) => {
    try {
        const { page, size, offset } = paging(req, 30);
        const where = {};
        const adminId = intOrNull(req.query.admin_id);
        if (adminId) where.admin_id = adminId;
        if (['user', 'event', 'media', 'order', 'admin'].includes(req.query.target_type)) where.target_type = req.query.target_type;
        const targetId = intOrNull(req.query.target_id);
        if (targetId) where.target_id = targetId;

        const { rows, count } = await models.admin_action.findAndCountAll({
            where,
            include: [{ model: models.user, as: 'admin', attributes: ['id', 'name', 'lastname', 'email'] }],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset,
        });
        return res.status(200).json({
            page, size, total: count,
            actions: rows.map((a) => ({
                id: a.id,
                action: a.action,
                target_type: a.target_type,
                target_id: a.target_id,
                details: a.details,
                created_at: a.createdAt,
                admin: a.admin ? { id: a.admin.id, name: fullName(a.admin), email: a.admin.email } : null,
            })),
        });
    } catch (error) {
        return fail(res, 'Activity', error);
    }
};
