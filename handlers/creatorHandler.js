const crypto = require('crypto');
const path = require('path');
const { Op, fn, col, UniqueConstraintError } = require('sequelize');
const models = require('../models');
const matcher = require('../helpers/eventMatcher');
const amazonHelper = require('../helpers/amazonHelper');
const pricing = require('../helpers/pricing');
const eventHandler = require('./EventHandler');
const mediaProcessor = require('../helpers/mediaProcessor');
const payments = require('../helpers/payments');

/**
 * Selling needs a ready payout account; replies 403 and returns null when there is none.
 * Returns the account (its currency is the photographer's selling currency).
 */
async function requirePayout(req, res) {
    const ready = await payments.readyAccount(req.dbUser.id);
    if (ready) return ready.account;
    res.status(403).json({
        code: 'PAYOUT_REQUIRED',
        message: 'Set up your payout account before adding events or uploading.',
    });
    return null;
}

const RETENTION_DAYS = 7;
const MAX_FILES_PER_REQUEST = 50;
// Files above this go up as S3 multipart uploads: resumable after a dropped
// connection, parts sent in parallel. Smaller files use one presigned PUT.
const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;          // S3 minimum is 5 MiB (except the last part)
const MAX_PART_URLS_PER_REQUEST = 50;
const LIMITS = {
    photo: { maxBytes: 50 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] },
    video: { maxBytes: 2 * 1024 * 1024 * 1024, types: ['video/mp4', 'video/quicktime', 'video/x-m4v'] },
};
// Events this far in the past can't be created — their media would already be expired.
const MAX_PAST_DAYS = 30;
const MAX_FUTURE_DAYS = 400;
const VISIBLE_STATUSES = ['uploaded', 'processing', 'ready', 'failed'];

function todayPlus(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function cleanText(value, max) {
    const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    return s ? s.slice(0, max) : null;
}

function partCount(sizeBytes, partSize) {
    return Math.ceil(sizeBytes / partSize);
}

function partLength(sizeBytes, partSize, partNumber) {
    const start = (partNumber - 1) * partSize;
    return Math.min(partSize, sizeBytes - start);
}

async function membershipFor(eventId, creatorId) {
    return models.event_photographer.findOne({ where: { event_id: eventId, creator_id: creatorId } });
}

async function mediaToJSON(item, eventPrice) {
    const [thumbUrl, url] = await Promise.all([
        amazonHelper.presignDownload(item.thumb_key),
        // The photographer can always view their own original.
        amazonHelper.presignDownload(item.original_key),
    ]);
    return {
        id: item.id,
        type: item.type,
        status: item.status,
        filename: item.filename,
        size_bytes: Number(item.size_bytes),
        width: item.width,
        height: item.height,
        price: item.price === null ? null : Number(item.price),
        effective_price: pricing.effectivePrice(item.price, eventPrice),
        thumb_url: thumbUrl,
        url,
        error: item.status === 'failed' ? item.error : null,
        duration_seconds: item.duration_seconds,
        face_count: item.face_count,
        uploaded_at: item.uploaded_at,
        expires_at: item.expires_at,
    };
}

function membershipJSON(membership) {
    return { price: Number(membership.price), currency: membership.currency, joined_at: membership.created_at };
}

// POST /api/creator/events  { name, venue?, city?, start_date, end_date?, price, confirm_new? }
exports.CreateEvent = async (req, res) => {
    try {
        const payout = await requirePayout(req, res);
        if (!payout) return;
        const name = cleanText(req.body.name, 150);
        const venue = cleanText(req.body.venue, 150);
        const city = cleanText(req.body.city, 100);
        const startDate = req.body.start_date;
        const endDate = req.body.end_date || startDate;
        const price = pricing.parsePrice(req.body.price);

        if (!name || name.length < 3 || !matcher.normalize(name).tokens.length) {
            return res.status(400).json({ message: 'Event name must be at least 3 characters' });
        }
        if (!eventHandler.isValidDate(startDate) || !eventHandler.isValidDate(endDate)) {
            return res.status(400).json({ message: 'Dates must be YYYY-MM-DD' });
        }
        if (endDate < startDate) return res.status(400).json({ message: 'End date cannot be before the start date' });
        if (startDate < todayPlus(-MAX_PAST_DAYS)) {
            return res.status(400).json({ message: `Events older than ${MAX_PAST_DAYS} days can't be created` });
        }
        if (startDate > todayPlus(MAX_FUTURE_DAYS)) return res.status(400).json({ message: 'Event date is too far in the future' });
        if (price === null) return res.status(400).json({ message: pricing.PRICE_RULE_MESSAGE });

        // Duplicate guard — enforced here even though the app searches first.
        const query = { name, venue, city, start_date: startDate, end_date: endDate };
        const matches = await eventHandler.findMatchingEvents(query, 5);
        const exact = matches.filter((m) => m.level === matcher.MATCH.EXACT);
        const likely = matches.filter((m) => m.level === matcher.MATCH.LIKELY);

        if (exact.length) {
            return res.status(409).json({
                code: 'EVENT_EXISTS',
                message: 'This event already exists. Join it instead of creating a new one.',
                matches: await eventHandler.decorateMatches(exact, req.dbUser.id),
            });
        }
        if (likely.length && req.body.confirm_new !== true) {
            return res.status(409).json({
                code: 'POSSIBLE_DUPLICATES',
                message: 'We found events that look the same. Join one of them, or confirm yours is different.',
                matches: await eventHandler.decorateMatches(likely, req.dbUser.id),
            });
        }

        const norm = matcher.normalize(name);
        const code = await eventHandler.generateEventCode();
        const result = await models.sequelize.transaction(async (transaction) => {
            const event = await models.event.create({
                name, venue, city,
                start_date: startDate, end_date: endDate,
                name_key: norm.key.slice(0, 191),
                name_phonetic: norm.phonetic.slice(0, 191),
                name_acronym: norm.acronym.slice(0, 30),
                code,
                created_by: req.dbUser.id,
                status: 'active',
            }, { transaction });
            const membership = await models.event_photographer.create({
                event_id: event.id, creator_id: req.dbUser.id, price, currency: payout.currency,
            }, { transaction });
            return { event, membership };
        });

        return res.status(201).json({
            message: 'Event created',
            event: result.event.toPublicJSON(),
            membership: membershipJSON(result.membership),
        });
    } catch (error) {
        if (error instanceof UniqueConstraintError) {
            // Another photographer created the same event a moment ago.
            return res.status(409).json({ code: 'EVENT_EXISTS', message: 'This event was just created. Search again to join it.' });
        }
        console.error('CreateEvent Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /api/creator/events/:id/join  { price }
exports.JoinEvent = async (req, res) => {
    try {
        const payout = await requirePayout(req, res);
        if (!payout) return;
        const event = await models.event.findOne({ where: { id: req.params.id, status: 'active' } });
        if (!event) return res.status(404).json({ message: 'Event not found' });
        const price = pricing.parsePrice(req.body.price);
        if (price === null) return res.status(400).json({ message: pricing.PRICE_RULE_MESSAGE });

        const [membership, created] = await models.event_photographer.findOrCreate({
            where: { event_id: event.id, creator_id: req.dbUser.id },
            defaults: { price, currency: payout.currency },
        });
        if (!created) return res.status(409).json({ message: 'You already joined this event' });

        return res.status(201).json({ message: 'Joined event', event: event.toPublicJSON(), membership: membershipJSON(membership) });
    } catch (error) {
        console.error('JoinEvent Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/creator/events
exports.MyEvents = async (req, res) => {
    try {
        const memberships = await models.event_photographer.findAll({
            where: { creator_id: req.dbUser.id },
            include: [{ model: models.event, as: 'event' }],
            order: [[{ model: models.event, as: 'event' }, 'start_date', 'DESC']],
        });
        const eventIds = memberships.map((m) => m.event_id);
        const [myCounts, photographerCounts] = eventIds.length ? await Promise.all([
            models.media.findAll({
                attributes: ['event_id', [fn('COUNT', col('id')), 'count'], [fn('MAX', col('expires_at')), 'last_expiry']],
                where: { event_id: eventIds, creator_id: req.dbUser.id, status: VISIBLE_STATUSES },
                group: ['event_id'], raw: true,
            }),
            models.event_photographer.findAll({
                attributes: ['event_id', [fn('COUNT', col('id')), 'count']],
                where: { event_id: eventIds }, group: ['event_id'], raw: true,
            }),
        ]) : [[], []];
        const mine = Object.fromEntries(myCounts.map((r) => [r.event_id, r]));
        const photographers = Object.fromEntries(photographerCounts.map((r) => [r.event_id, Number(r.count)]));

        return res.status(200).json({
            events: memberships.map((m) => ({
                ...m.event.toPublicJSON(),
                membership: membershipJSON(m),
                my_media_count: Number(mine[m.event_id]?.count || 0),
                last_expiry: mine[m.event_id]?.last_expiry || null,
                photographer_count: photographers[m.event_id] || 1,
                is_owner: m.event.created_by === req.dbUser.id,
            })),
        });
    } catch (error) {
        console.error('MyEvents Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/creator/events/:id
exports.EventDetail = async (req, res) => {
    try {
        const membership = await membershipFor(req.params.id, req.dbUser.id);
        if (!membership) return res.status(404).json({ message: 'Event not found' });
        const [event, items, photographerCount] = await Promise.all([
            models.event.findByPk(req.params.id),
            models.media.findAll({
                where: { event_id: req.params.id, creator_id: req.dbUser.id, status: VISIBLE_STATUSES },
                order: [['created_at', 'DESC']],
            }),
            models.event_photographer.count({ where: { event_id: req.params.id } }),
        ]);
        return res.status(200).json({
            event: event.toPublicJSON(),
            membership: membershipJSON(membership),
            photographer_count: photographerCount,
            retention_days: RETENTION_DAYS,
            media: await Promise.all(items.map((item) => mediaToJSON(item, membership.price))),
        });
    } catch (error) {
        console.error('EventDetail Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT /api/creator/events/:id/price  { price }
exports.UpdateEventPrice = async (req, res) => {
    try {
        const membership = await membershipFor(req.params.id, req.dbUser.id);
        if (!membership) return res.status(404).json({ message: 'Event not found' });
        const price = pricing.parsePrice(req.body.price);
        if (price === null) return res.status(400).json({ message: pricing.PRICE_RULE_MESSAGE });
        await membership.update({ price });
        return res.status(200).json({ message: 'Price updated', membership: membershipJSON(membership) });
    } catch (error) {
        console.error('UpdateEventPrice Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /api/creator/events/:id/media/upload-urls  { files: [{ filename, content_type, size }] }
exports.CreateUploadUrls = async (req, res) => {
    try {
        const payout = await requirePayout(req, res);
        if (!payout) return;
        const membership = await membershipFor(req.params.id, req.dbUser.id);
        if (!membership) return res.status(404).json({ message: 'Join the event before uploading' });

        const files = Array.isArray(req.body.files) ? req.body.files : [];
        if (!files.length) return res.status(400).json({ message: 'No files provided' });
        if (files.length > MAX_FILES_PER_REQUEST) {
            return res.status(400).json({ message: `Upload at most ${MAX_FILES_PER_REQUEST} files at a time` });
        }

        // Validate everything before creating any rows.
        const prepared = [];
        for (const [index, f] of files.entries()) {
            const contentType = String(f.content_type || '').toLowerCase();
            const size = Number(f.size);
            const type = LIMITS.photo.types.includes(contentType) ? 'photo'
                : LIMITS.video.types.includes(contentType) ? 'video' : null;
            if (!type) return res.status(400).json({ message: `File ${index + 1}: unsupported type ${contentType || '(none)'}` });
            if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ message: `File ${index + 1}: invalid size` });
            if (size > LIMITS[type].maxBytes) {
                const mb = Math.round(LIMITS[type].maxBytes / 1024 / 1024);
                return res.status(400).json({ message: `File ${index + 1}: ${type}s can be at most ${mb} MB` });
            }
            const ext = (path.extname(String(f.filename || '')).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin').slice(0, 8);
            prepared.push({ type, contentType, size, filename: cleanText(f.filename, 255), ext });
        }

        const uploads = [];
        for (const f of prepared) {
            const key = `events/${req.params.id}/${req.dbUser.id}/originals/${crypto.randomUUID()}${f.ext}`;
            const multipart = f.size > MULTIPART_THRESHOLD;
            const uploadId = multipart ? await amazonHelper.createMultipartUpload(key, f.contentType) : null;
            const item = await models.media.create({
                event_id: Number(req.params.id),
                creator_id: req.dbUser.id,
                type: f.type,
                original_key: key,
                filename: f.filename,
                mime_type: f.contentType,
                size_bytes: f.size,
                status: 'pending',
                upload_id: uploadId,
                part_size: multipart ? PART_SIZE : null,
            });
            uploads.push(multipart
                ? {
                    media_id: item.id,
                    type: f.type,
                    mode: 'multipart',
                    part_size: PART_SIZE,
                    part_count: partCount(f.size, PART_SIZE),
                }
                : {
                    media_id: item.id,
                    type: f.type,
                    mode: 'single',
                    method: 'PUT',
                    upload_url: await amazonHelper.presignUpload(key, f.contentType, f.size),
                    headers: { 'Content-Type': f.contentType },
                    expires_in: amazonHelper.UPLOAD_URL_TTL_SECONDS,
                });
        }
        return res.status(201).json({ uploads });
    } catch (error) {
        console.error('CreateUploadUrls Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

async function ownMedia(req) {
    return models.media.findOne({
        where: { id: req.params.id, creator_id: req.dbUser.id, status: { [Op.ne]: 'deleted' } },
    });
}

async function pendingMultipart(req, res) {
    const item = await ownMedia(req);
    if (!item) {
        res.status(404).json({ message: 'Upload not found' });
        return null;
    }
    if (item.status !== 'pending' || !item.upload_id) {
        res.status(409).json({ message: 'This upload is not an in-progress multipart upload' });
        return null;
    }
    return item;
}

// POST /api/creator/media/:id/parts  { part_numbers: [1, 2, ...] }  (≤ 50 per call)
// Signed URLs for the requested parts; the app asks just before sending them.
exports.CreatePartUrls = async (req, res) => {
    try {
        const item = await pendingMultipart(req, res);
        if (!item) return;
        const total = partCount(Number(item.size_bytes), item.part_size);
        const numbers = Array.isArray(req.body.part_numbers) ? [...new Set(req.body.part_numbers.map(Number))] : [];
        if (!numbers.length || numbers.length > MAX_PART_URLS_PER_REQUEST) {
            return res.status(400).json({ message: `Request between 1 and ${MAX_PART_URLS_PER_REQUEST} parts` });
        }
        if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > total)) {
            return res.status(400).json({ message: `Part numbers must be between 1 and ${total}` });
        }

        const parts = await Promise.all(numbers.map(async (n) => {
            const size = partLength(Number(item.size_bytes), item.part_size, n);
            return {
                part_number: n,
                size,
                offset: (n - 1) * item.part_size,
                url: await amazonHelper.presignPart(item.original_key, item.upload_id, n, size),
            };
        }));
        return res.status(200).json({ parts, expires_in: amazonHelper.PART_URL_TTL_SECONDS });
    } catch (error) {
        console.error('CreatePartUrls Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/creator/media/:id/parts — which parts S3 already has (used to resume).
exports.ListUploadedParts = async (req, res) => {
    try {
        const item = await pendingMultipart(req, res);
        if (!item) return;
        const parts = await amazonHelper.listParts(item.original_key, item.upload_id);
        return res.status(200).json({
            part_size: item.part_size,
            part_count: partCount(Number(item.size_bytes), item.part_size),
            uploaded: parts.map((p) => p.PartNumber).sort((a, b) => a - b),
        });
    } catch (error) {
        console.error('ListUploadedParts Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// Finishes a multipart upload from S3's own record of the parts (the client
// doesn't send ETags). Returns an error message, or null on success.
async function completeMultipart(item) {
    let parts;
    try {
        parts = await amazonHelper.listParts(item.original_key, item.upload_id);
    } catch (err) {
        // Already completed by an earlier /complete call that didn't get to save.
        if (err.name === 'NoSuchUpload' && (await amazonHelper.head(item.original_key))) return null;
        throw err;
    }
    const total = partCount(Number(item.size_bytes), item.part_size);
    const byNumber = new Map(parts.map((p) => [p.PartNumber, p]));
    const missing = [];
    for (let n = 1; n <= total; n++) {
        const part = byNumber.get(n);
        if (!part || part.Size !== partLength(Number(item.size_bytes), item.part_size, n)) missing.push(n);
    }
    if (missing.length) {
        return `Upload incomplete: ${missing.length} part(s) still missing`;
    }
    await amazonHelper.completeMultipartUpload(item.original_key, item.upload_id, [...byNumber.values()].sort((a, b) => a.PartNumber - b.PartNumber));
    return null;
}

// POST /api/creator/media/:id/complete — called after the file (or every part) is in S3.
exports.CompleteUpload = async (req, res) => {
    try {
        const item = await ownMedia(req);
        if (!item) return res.status(404).json({ message: 'Upload not found' });
        if (item.status !== 'pending') {
            const membership = await membershipFor(item.event_id, req.dbUser.id);
            return res.status(200).json({ media: await mediaToJSON(item, membership.price) });
        }

        if (item.upload_id) {
            const problem = await completeMultipart(item);
            if (problem) return res.status(409).json({ message: problem });
        }

        const head = await amazonHelper.head(item.original_key);
        if (!head) return res.status(409).json({ message: 'File has not finished uploading yet' });

        const now = new Date();
        await item.update({
            size_bytes: head.ContentLength,
            upload_id: null,
            // The background job makes thumbnails/previews and indexes faces (videos: poster,
            // preview clip and sampled frames) before the item becomes `ready`.
            status: 'uploaded',
            uploaded_at: now,
            expires_at: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
        });
        const membership = await membershipFor(item.event_id, req.dbUser.id);
        return res.status(200).json({ media: await mediaToJSON(item, membership.price) });
    } catch (error) {
        console.error('CompleteUpload Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// PUT /api/creator/media/:id/price  { price: number | null }   null → use the event price again
exports.UpdateMediaPrice = async (req, res) => {
    try {
        const item = await ownMedia(req);
        if (!item) return res.status(404).json({ message: 'Media not found' });
        let price = null;
        if (req.body.price !== null && req.body.price !== undefined) {
            price = pricing.parsePrice(req.body.price);
            if (price === null) return res.status(400).json({ message: pricing.PRICE_RULE_MESSAGE });
        }
        await item.update({ price });
        const membership = await membershipFor(item.event_id, req.dbUser.id);
        return res.status(200).json({ message: 'Price updated', media: await mediaToJSON(item, membership.price) });
    } catch (error) {
        console.error('UpdateMediaPrice Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// DELETE /api/creator/media/:id
exports.DeleteMedia = async (req, res) => {
    try {
        const item = await ownMedia(req);
        if (!item) return res.status(404).json({ message: 'Media not found' });
        await mediaProcessor.purge([item]); // S3 files, in-progress multipart upload, face data
        await item.update({ status: 'deleted', upload_id: null, face_count: 0 });
        return res.status(200).json({ message: 'Deleted' });
    } catch (error) {
        console.error('DeleteMedia Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/creator/dashboard
exports.Dashboard = async (req, res) => {
    try {
        const live = { creator_id: req.dbUser.id, status: VISIBLE_STATUSES, expires_at: { [Op.gt]: new Date() } };
        const [liveEvents, uploads, account, earned, sold] = await Promise.all([
            models.media.count({ where: live, distinct: true, col: 'event_id' }),
            models.media.count({ where: live }),
            payments.accountOf(req.dbUser.id),
            // Photographer's share: the item prices; the platform fee is on top.
            models.order.sum('subtotal', { where: { creator_id: req.dbUser.id, status: 'PAID' } }),
            models.order_item.count({ include: [{ model: models.order, as: 'order', where: { creator_id: req.dbUser.id, status: 'PAID' } }] }),
        ]);
        return res.status(200).json({
            live_events: liveEvents,
            uploads,
            earned: Number(earned || 0),
            items_sold: sold,
            currency: account?.currency || pricing.CURRENCY,
            payout_ready: !!account?.isReady,
            payout: account ? payoutJSON(account) : null,
        });
    } catch (error) {
        console.error('Dashboard Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// ── Payout account (the photographer's account with their country's payment gateway) ──

function payoutJSON(account) {
    let label = account.provider;
    try { label = payments.provider(account.provider).label; } catch { /* gateway removed */ }
    const d = account.detailsJSON();
    return {
        ...account.toPublicJSON(),
        provider_label: label,
        test_mode: (() => { try { return payments.testMode(account.provider); } catch { return false; } })(),
        // Display-safe summary only (no secrets, bank numbers masked at creation).
        summary: [d.bank_name, d.account_last4 ? `••••${d.account_last4}` : null, d.phone].filter(Boolean).join(' · ') || null,
    };
}

// GET /api/creator/payout
exports.GetPayout = async (req, res) => {
    const account = await payments.accountOf(req.dbUser.id);
    return res.status(200).json({ payout_ready: !!account?.isReady, payout: account ? payoutJSON(account) : null });
};

// POST /api/creator/payout { country, values } — for photographers who signed up before payments.
exports.SetupPayout = async (req, res) => {
    let checked = null;
    try {
        if (await payments.accountOf(req.dbUser.id)) {
            return res.status(409).json({ message: 'Your payout account is already set up' });
        }
        const result = await payments.openAccount(req.dbUser, { country: req.body.country, values: req.body.values });
        checked = result;
        if (result.error) return res.status(400).json({ message: result.error });
        return res.status(201).json({ message: 'Payout account created', payout: payoutJSON(result.account) });
    } catch (error) {
        if (error instanceof payments.PaymentError) {
            const route = payments.forCountry(req.body.country);
            return res.status(error.httpStatus() === 401 ? 502 : error.httpStatus())
                .json({ message: `${route?.provider.label || 'The payment gateway'} couldn’t open your payout account: ${error.message}` });
        }
        console.error('SetupPayout Error:', error, checked);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// ── Sales: from our own order ledger (same for every gateway), plus the gateway balance when
// the gateway reports one (SmatPay does; Paystack settles straight to the bank). ──

const STATUS_LABELS = { PAID: 'Paid', PENDING: 'Pending', FAILED: 'Failed', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };

// GET /api/creator/sales/summary
exports.SalesSummary = async (req, res) => {
    try {
        const account = await payments.accountOf(req.dbUser.id);
        const ready = !!account?.isReady;
        const [earned, itemsSold, paidOrders] = await Promise.all([
            models.order.sum('subtotal', { where: { creator_id: req.dbUser.id, status: 'PAID' } }),
            models.order_item.count({ include: [{ model: models.order, as: 'order', where: { creator_id: req.dbUser.id, status: 'PAID' } }] }),
            models.order.count({ where: { creator_id: req.dbUser.id, status: 'PAID' } }),
        ]);
        const body = {
            payout_ready: ready,
            payout: account ? payoutJSON(account) : null,
            earned: Number(earned || 0),
            items_sold: itemsSold,
            sales: paidOrders,
            currency: account?.currency || pricing.CURRENCY,
            balances: null,
            balance_error: null,
            balance_note: null,
        };
        if (ready) {
            let provider = null;
            try { provider = payments.provider(account.provider); } catch { /* gateway removed */ }
            if (provider?.sellerBalance) {
                try {
                    body.balances = await provider.sellerBalance(account);
                } catch (error) {
                    console.error('SalesSummary balance:', error.message);
                    body.balance_error = error instanceof payments.PaymentError ? error.message : `Could not load your ${provider.label} balance.`;
                }
            } else if (provider) {
                body.balance_note = `${provider.label} pays your earnings into your bank account automatically.`;
            }
        }
        return res.status(200).json(body);
    } catch (error) {
        console.error('SalesSummary Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/creator/sales/transactions?page=1&size=20 — the photographer's orders, newest first
// (abandoned checkouts left out).
exports.SalesTransactions = async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const size = Math.min(50, Math.max(1, Number.parseInt(req.query.size, 10) || 20));
        const { rows, count } = await models.order.findAndCountAll({
            where: { creator_id: req.dbUser.id, status: ['PAID', 'PENDING', 'FAILED', 'CANCELLED'] },
            include: [
                { model: models.event, as: 'event', attributes: ['id', 'name'] },
                { model: models.user, as: 'client', attributes: ['name', 'lastname'] },
            ],
            order: [['created_at', 'DESC'], ['id', 'DESC']],
            limit: size,
            offset: (page - 1) * size,
        });
        const counts = rows.length ? await models.order_item.findAll({
            attributes: ['order_id', [fn('COUNT', col('id')), 'n']],
            where: { order_id: rows.map((o) => o.id) },
            group: ['order_id'],
            raw: true,
        }) : [];
        const itemsOf = new Map(counts.map((c) => [c.order_id, Number(c.n)]));
        return res.status(200).json({
            page,
            size,
            total: count,
            transactions: rows.map((o) => ({
                id: o.id,
                reference: o.reference,
                // The photographer's share; the client also paid the platform fee on top.
                amount: Number(o.subtotal),
                fee: Number(o.fee),
                currency: o.currency,
                provider: o.provider,
                method: o.wallet,
                status: STATUS_LABELS[o.status] || o.status,
                payer: o.client ? `${o.client.name} ${o.client.lastname}`.trim() : null,
                created_at: o.created_at,
                paid_at: o.paid_at,
                order: {
                    id: o.id,
                    event: o.event ? { id: o.event.id, name: o.event.name } : null,
                    item_count: itemsOf.get(o.id) || 0,
                    status: o.status,
                },
            })),
        });
    } catch (error) {
        console.error('SalesTransactions Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
