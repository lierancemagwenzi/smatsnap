const crypto = require('crypto');
const { Op, fn, col } = require('sequelize');
const models = require('../models');
const matcher = require('../helpers/eventMatcher');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function addDays(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

/**
 * Pulls a broad candidate set from MySQL (cheap LIKE / equality on pre-normalised
 * columns), then scores and ranks it in JS with helpers/eventMatcher.
 */
async function findMatchingEvents(query, limit = 10) {
    const norm = matcher.normalize(query.name);
    const ors = [];

    for (const token of norm.tokens) {
        // Leading 4 chars tolerate typos/suffix differences later in the word.
        if (token.length >= 3) ors.push({ name_key: { [Op.like]: `%${token.slice(0, 4)}%` } });
    }
    for (const code of norm.phonetic.split(' ')) {
        if (code.length >= 2) ors.push({ name_phonetic: { [Op.like]: `%${code}%` } });
    }
    if (norm.tokens.length === 1) ors.push({ name_acronym: norm.tokens[0] });       // "HIFA" → full name
    if (norm.tokens.length >= 2) ors.push({ name_key: norm.acronym });               // full name → "HIFA"
    if (query.start_date) {
        ors.push({ start_date: { [Op.between]: [addDays(query.start_date, -3), addDays(query.end_date || query.start_date, 3)] } });
    }
    if (!ors.length) return [];

    const candidates = await models.event.findAll({
        where: { status: 'active', [Op.or]: ors },
        order: [['start_date', 'DESC']],
        limit: 300,
    });
    return matcher.rankEvents(query, candidates.map((e) => e.get({ plain: true })), limit);
}

/** Adds photographer/media counts and whether `userId` already joined. */
async function decorateMatches(matches, userId) {
    const ids = matches.map((m) => m.event.id);
    if (!ids.length) return [];

    const [photographers, mediaCounts, mine] = await Promise.all([
        models.event_photographer.findAll({
            attributes: ['event_id', [fn('COUNT', col('id')), 'count']],
            where: { event_id: ids }, group: ['event_id'], raw: true,
        }),
        models.media.findAll({
            attributes: ['event_id', [fn('COUNT', col('id')), 'count']],
            where: { event_id: ids, status: 'ready' }, group: ['event_id'], raw: true,
        }),
        models.event_photographer.findAll({ where: { event_id: ids, creator_id: userId }, raw: true }),
    ]);
    const countBy = (rows) => Object.fromEntries(rows.map((r) => [r.event_id, Number(r.count)]));
    const photographerCount = countBy(photographers);
    const mediaCount = countBy(mediaCounts);
    const joined = new Set(mine.map((r) => r.event_id));

    return matches.map((m) => ({
        event: {
            id: m.event.id, name: m.event.name, venue: m.event.venue, city: m.event.city,
            start_date: m.event.start_date, end_date: m.event.end_date, code: m.event.code,
        },
        match: m.level,
        score: m.score,
        photographer_count: photographerCount[m.event.id] || 0,
        media_count: mediaCount[m.event.id] || 0,
        joined: joined.has(m.event.id),
    }));
}

async function generateEventCode() {
    for (let attempt = 0; attempt < 10; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        if (!(await models.event.findOne({ where: { code } }))) return code;
    }
    throw new Error('Could not generate a unique event code');
}

exports.findMatchingEvents = findMatchingEvents;
exports.decorateMatches = decorateMatches;
exports.generateEventCode = generateEventCode;
exports.isValidDate = isValidDate;

// GET /api/events/search?q=&date=&end_date=&venue=&city=
exports.SearchEvents = async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.status(400).json({ message: 'Type at least 2 characters to search' });
        if (q.length > 150) return res.status(400).json({ message: 'Search is too long' });

        const query = { name: q, venue: req.query.venue, city: req.query.city };
        if (req.query.date) {
            if (!isValidDate(req.query.date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
            query.start_date = req.query.date;
            if (req.query.end_date && isValidDate(req.query.end_date)) query.end_date = req.query.end_date;
        }

        // An exact event code (e.g. from a photographer's QR/poster) jumps straight to that event.
        if (/^[A-Za-z2-9]{6}$/.test(q)) {
            const byCode = await models.event.findOne({ where: { code: q.toUpperCase(), status: 'active' } });
            if (byCode) {
                const exact = [{ event: byCode.get({ plain: true }), level: matcher.MATCH.EXACT, score: 1 }];
                return res.status(200).json({ results: await decorateMatches(exact, req.dbUser.id) });
            }
        }

        const matches = await findMatchingEvents(query, 15);
        return res.status(200).json({ results: await decorateMatches(matches, req.dbUser.id) });
    } catch (error) {
        console.error('SearchEvents Error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
