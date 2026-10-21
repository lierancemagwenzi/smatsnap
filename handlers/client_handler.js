const sharp = require('sharp');
const { Op, fn, col } = require('sequelize');
const models = require('../models');
const faces = require('../helpers/faces');
const amazonHelper = require('../helpers/amazonHelper');
const pricing = require('../helpers/pricing');

const LIVE = () => ({ status: 'ready', expires_at: { [Op.gt]: new Date() } });

async function eventSummary(event) {
    const [photographerCount, mediaCount] = await Promise.all([
        models.event_photographer.count({ where: { event_id: event.id } }),
        models.media.count({ where: { event_id: event.id, ...LIVE() } }),
    ]);
    return { ...event.toPublicJSON(), photographer_count: photographerCount, media_count: mediaCount };
}

/** A client's visible matches in an event, with watermarked preview URLs and prices. */
async function matchesFor(clientId, eventId) {
    const rows = await models.client_match.findAll({
        where: { client_id: clientId, event_id: eventId, hidden: false },
        include: [{
            model: models.media,
            as: 'media',
            where: LIVE(),
            include: [{ model: models.user, as: 'creator', attributes: ['id', 'name', 'lastname'] }],
        }],
        order: [['similarity', 'DESC']],
    });
    if (!rows.length) return [];

    const memberships = await models.event_photographer.findAll({ where: { event_id: eventId }, raw: true });
    const priceByCreator = Object.fromEntries(memberships.map((m) => [m.creator_id, m]));

    return Promise.all(rows.map(async (row) => {
        const m = row.media;
        const membership = priceByCreator[m.creator_id] || { price: 0, currency: pricing.CURRENCY };
        const [thumbUrl, previewUrl] = await Promise.all([
            amazonHelper.presignDownload(m.preview_thumb_key),
            amazonHelper.presignDownload(m.preview_key),
        ]);
        return {
            media_id: m.id,
            type: m.type,
            width: m.width,
            height: m.height,
            duration_seconds: m.duration_seconds,
            // Watermarked only — originals are released after payment (next phase).
            thumb_url: thumbUrl,
            preview_url: previewUrl,
            price: pricing.effectivePrice(m.price, membership.price),
            currency: membership.currency,
            photographer: { id: m.creator.id, name: `${m.creator.name} ${m.creator.lastname}`.trim() },
            similarity: Math.round(row.similarity * 1000) / 1000,
            // Video: seconds where the client's face appears (for "jump to").
            appears_at: row.times,
            expires_at: m.expires_at,
        };
    }));
}

// GET /api/client/events — events this client searched, with match counts.
exports.MyEvents = async (req, res) => {
    try {
        const searched = await models.client_event.findAll({
            where: { client_id: req.dbUser.id },
            include: [{ model: models.event, as: 'event' }],
            order: [['last_searched_at', 'DESC']],
        });
        const counts = searched.length ? await models.client_match.findAll({
            attributes: ['event_id', [fn('COUNT', col('client_match.id')), 'count']],
            where: { client_id: req.dbUser.id, hidden: false, event_id: searched.map((s) => s.event_id) },
            include: [{ model: models.media, as: 'media', attributes: [], where: LIVE() }],
            group: ['event_id'],
            raw: true,
        }) : [];
        const countBy = Object.fromEntries(counts.map((c) => [c.event_id, Number(c.count)]));
        return res.status(200).json({
            events: searched.map((s) => ({
                ...s.event.toPublicJSON(),
                match_count: countBy[s.event_id] || 0,
                last_searched_at: s.last_searched_at,
            })),
        });
    } catch (error) {
        console.error('Client MyEvents Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// GET /api/client/events/:id
exports.EventDetail = async (req, res) => {
    try {
        const event = await models.event.findOne({ where: { id: req.params.id, status: 'active' } });
        if (!event) return res.status(404).json({ message: 'Event not found' });
        const searched = await models.client_event.findOne({ where: { client_id: req.dbUser.id, event_id: event.id } });
        return res.status(200).json({
            event: await eventSummary(event),
            searched: !!searched,
            last_searched_at: searched?.last_searched_at || null,
            face_consent: !!req.dbUser.face_consent_at,
            matches: searched ? await matchesFor(req.dbUser.id, event.id) : [],
        });
    } catch (error) {
        console.error('Client EventDetail Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

// POST /api/client/events/:id/face-search   multipart: selfie (image), consent=true (first time)
// The selfie is processed in memory and never stored.
exports.FaceSearch = async (req, res) => {
    try {
        const event = await models.event.findOne({ where: { id: req.params.id, status: 'active' } });
        if (!event) return res.status(404).json({ message: 'Event not found' });
        if (!req.file) return res.status(400).json({ message: 'Take a selfie to search' });

        if (!req.dbUser.face_consent_at) {
            if (req.body.consent !== 'true' && req.body.consent !== true) {
                return res.status(428).json({
                    code: 'CONSENT_REQUIRED',
                    message: 'Please agree to face matching before searching.',
                });
            }
            await req.dbUser.update({ face_consent_at: new Date() });
        }

        let selfie;
        try {
            selfie = await sharp(req.file.buffer, { failOn: 'none' })
                .rotate()
                .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer();
        } catch {
            return res.status(400).json({ message: 'That image could not be read. Try taking the selfie again.' });
        }

        let found;
        try {
            found = await faces.search(event.id, selfie);
        } catch (err) {
            if (err instanceof faces.SelfieError) return res.status(422).json({ code: err.code, message: err.message });
            throw err;
        }

        // Only keep hits on media that's live, and remember "not me" choices from earlier searches.
        const live = new Set((await models.media.findAll({
            attributes: ['id'], where: { id: found.map((f) => f.mediaId), event_id: event.id, ...LIVE() }, raw: true,
        })).map((m) => m.id));
        const existing = await models.client_match.findAll({ where: { client_id: req.dbUser.id, event_id: event.id } });
        const existingBy = new Map(existing.map((m) => [m.media_id, m]));

        await models.sequelize.transaction(async (transaction) => {
            for (const hit of found.filter((f) => live.has(f.mediaId))) {
                const prev = existingBy.get(hit.mediaId);
                if (prev) {
                    await prev.update({ similarity: hit.similarity, times: hit.times }, { transaction });
                } else {
                    await models.client_match.create({
                        client_id: req.dbUser.id, event_id: event.id, media_id: hit.mediaId,
                        similarity: hit.similarity, times: hit.times, hidden: false,
                    }, { transaction });
                }
            }
            const [row] = await models.client_event.findOrCreate({
                where: { client_id: req.dbUser.id, event_id: event.id }, transaction,
            });
            await row.update({ last_searched_at: new Date() }, { transaction });
        });

        const matches = await matchesFor(req.dbUser.id, event.id);
        return res.status(200).json({
            message: matches.length ? `We found ${matches.length} match${matches.length === 1 ? '' : 'es'}` : 'No matches yet',
            matches,
        });
    } catch (error) {
        console.error('FaceSearch Error:', error);
        return res.status(500).json({ message: 'Face search is unavailable right now. Please try again shortly.' });
    }
};

// POST /api/client/matches/:mediaId/hide — "That's not me".
exports.HideMatch = async (req, res) => {
    try {
        const [updated] = await models.client_match.update(
            { hidden: true },
            { where: { client_id: req.dbUser.id, media_id: req.params.mediaId } }
        );
        if (!updated) return res.status(404).json({ message: 'Match not found' });
        return res.status(200).json({ message: 'Removed from your photos' });
    } catch (error) {
        console.error('HideMatch Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
