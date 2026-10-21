// Fuzzy event matching used to stop photographers creating the same event twice.
//
// Events are shared: "Harare Jazz Festival 2026" should exist once, and every
// photographer shooting it joins that one record. Photographers type names
// inconsistently ("HJF", "harare jazz fest", "Jazz Festival - Harare", typos),
// so a plain LIKE search isn't enough. This module:
//   1. normalises names (accents, punctuation, "&"→"and", abbreviations, plurals,
//      stopwords, years split out),
//   2. scores similarity with several complementary signals (typo-tolerant token
//      matching, character trigrams, sound-alike keys, acronyms, containment),
//   3. folds in the event dates — the same name months apart is a different
//      edition, not a duplicate.
//
// Pure functions only; database retrieval of candidates lives in EventHandler.

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'of', 'at', 'in', 'on', 'for', 'by', 'with', 'to', 'from',
    'de', 'la', 'le', 'el', 'du', 'des',
]);

// Common abbreviations → canonical word. Applied per token after lower-casing.
const SYNONYMS = {
    fest: 'festival', fst: 'festival', festivals: 'festival',
    intl: 'international', int: 'international', internat: 'international',
    natl: 'national', nat: 'national',
    conf: 'conference', confs: 'conference',
    champs: 'championship', champ: 'championship', championships: 'championship',
    uni: 'university', univ: 'university',
    assoc: 'association', assn: 'association',
    anniv: 'anniversary', ann: 'anniversary',
    bday: 'birthday',
    expo: 'exhibition',
    vs: 'versus', v: 'versus',
    mt: 'mount',
    ctr: 'centre', center: 'centre',
    theatre: 'theater',
    colour: 'color',
    grad: 'graduation',
    ceremony: 'ceremony',
    awards: 'award',
};

const ORDINAL_RE = /^(\d+)(st|nd|rd|th)$/;
const YEAR_RE = /^(19|20)\d{2}$/;

function stripAccents(s) {
    return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function singular(token) {
    if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
        return token.slice(0, -1);
    }
    return token;
}

function canonicalToken(raw) {
    let t = raw;
    const ordinal = t.match(ORDINAL_RE);
    if (ordinal) t = ordinal[1];
    if (SYNONYMS[t]) return SYNONYMS[t];
    t = singular(t);
    return SYNONYMS[t] || t;
}

/**
 * @returns {{ tokens: string[], allTokens: string[], years: string[], key: string, phonetic: string, acronym: string }}
 *   tokens     – content tokens (no stopwords, no years), canonicalised, in original order
 *   allTokens  – including stopwords (for acronyms like "HIFA" = Harare International Festival of the Arts)
 *   key        – sorted unique content tokens; identical keys = same name (stored + unique-indexed)
 *   phonetic   – sorted unique sound-alike codes (stored, used for DB candidate retrieval)
 *   acronym    – initials of content tokens (stored, used for DB candidate retrieval)
 */
function normalize(name) {
    const cleaned = stripAccents(String(name || '').toLowerCase())
        .replace(/[&+]/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const rawTokens = cleaned ? cleaned.split(/\s+/) : [];
    const years = [];
    const tokens = [];
    const allTokens = [];

    for (const raw of rawTokens) {
        if (YEAR_RE.test(raw)) {
            years.push(raw);
            continue;
        }
        const t = canonicalToken(raw);
        allTokens.push(t);
        if (!STOPWORDS.has(t)) tokens.push(t);
    }

    const unique = [...new Set(tokens)];
    return {
        tokens,
        allTokens,
        years,
        key: [...unique].sort().join(' '),
        phonetic: [...new Set(unique.map(phoneticCode))].sort().join(' '),
        acronym: tokens.map((t) => t[0]).join(''),
    };
}

// Lightweight sound-alike code (metaphone-flavoured): "Kwame"/"Quame",
// "Phestival"/"Festival", "Harrare"/"Harare" collapse to the same code.
function phoneticCode(token) {
    if (/^\d+$/.test(token)) return token;
    let t = token
        .replace(/^(kn|gn|pn|wr)/, (m) => m[1])
        .replace(/ph/g, 'f')
        .replace(/ck/g, 'k')
        .replace(/sch/g, 'sk')
        .replace(/th/g, '0')
        .replace(/c(?=[eiy])/g, 's')
        .replace(/c/g, 'k')
        .replace(/q/g, 'k')
        .replace(/x/g, 'ks')
        .replace(/z/g, 's')
        .replace(/dg/g, 'j')
        .replace(/gh/g, '')
        .replace(/v/g, 'f');
    const first = /^[aeiou]/.test(t) ? 'a' : t[0];
    const rest = t.slice(1).replace(/[aeiouyhw]/g, '');
    return (first + rest).replace(/(.)\1+/g, '$1').slice(0, 8);
}

function jaroWinkler(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aMatches = new Array(a.length).fill(false);
    const bMatches = new Array(b.length).fill(false);
    let matches = 0;

    for (let i = 0; i < a.length; i++) {
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(i + matchWindow + 1, b.length);
        for (let j = start; j < end; j++) {
            if (bMatches[j] || a[i] !== b[j]) continue;
            aMatches[i] = bMatches[j] = true;
            matches++;
            break;
        }
    }
    if (!matches) return 0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < a.length; i++) {
        if (!aMatches[i]) continue;
        while (!bMatches[k]) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
    }
    const m = matches;
    const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;

    let prefix = 0;
    while (prefix < 4 && a[prefix] && a[prefix] === b[prefix]) prefix++;
    return jaro + prefix * 0.1 * (1 - jaro);
}

// Similarity of two single tokens in [0,1], tolerant of typos and spelling variants.
function tokenSimilarity(a, b) {
    if (a === b) return 1;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return 0; // numbers must match exactly
    if (a.length >= 3 && b.length >= 3 && phoneticCode(a) === phoneticCode(b)) return 0.92;
    const jw = jaroWinkler(a, b);
    // Short tokens need a near-exact hit, otherwise "art"/"arc" would match.
    const threshold = Math.min(a.length, b.length) <= 4 ? 0.93 : 0.86;
    return jw >= threshold ? jw : 0;
}

/**
 * Soft Dice: every token on the smaller side is paired with its best match on the
 * other side (each used once). Word order doesn't matter; typos still count.
 * Returns { dice, coverage } where coverage = matched share of the smaller side.
 */
function softTokenMatch(tokensA, tokensB) {
    const a = [...new Set(tokensA)];
    const b = [...new Set(tokensB)];
    if (!a.length || !b.length) return { dice: 0, coverage: 0 };
    const [small, large] = a.length <= b.length ? [a, b] : [b, a];
    const used = new Set();
    let total = 0;
    let matched = 0;

    for (const s of small) {
        let best = 0;
        let bestIdx = -1;
        large.forEach((l, idx) => {
            if (used.has(idx)) return;
            const sim = tokenSimilarity(s, l);
            if (sim > best) {
                best = sim;
                bestIdx = idx;
            }
        });
        if (bestIdx >= 0) {
            used.add(bestIdx);
            total += best;
            matched++;
        }
    }
    return {
        dice: (2 * total) / (a.length + b.length),
        coverage: matched / small.length,
        smallSize: small.length,
        largeSize: large.length,
        // Both sides keep a word the other lacks ("Harare FOOD Festival" vs "Harare JAZZ
        // Festival", "John & GRACE" vs "John & MARY") — a strong sign of different events,
        // unlike one name simply being a shorter form of the other.
        conflict: matched < small.length && matched < large.length,
    };
}

function trigrams(s) {
    const padded = `  ${s} `;
    const grams = new Map();
    for (let i = 0; i < padded.length - 2; i++) {
        const g = padded.slice(i, i + 3);
        grams.set(g, (grams.get(g) || 0) + 1);
    }
    return grams;
}

function trigramDice(a, b) {
    if (!a || !b) return 0;
    const ga = trigrams(a);
    const gb = trigrams(b);
    let overlap = 0;
    let sizeA = 0;
    let sizeB = 0;
    ga.forEach((count, g) => {
        sizeA += count;
        overlap += Math.min(count, gb.get(g) || 0);
    });
    gb.forEach((count) => { sizeB += count; });
    return (2 * overlap) / (sizeA + sizeB);
}

function isAcronymOf(short, full) {
    if (short.tokens.length !== 1) return false;
    const candidate = short.tokens[0];
    if (candidate.length < 2 || candidate.length > 8 || full.tokens.length < 2) return false;
    const withStop = full.allTokens.filter((t) => t).map((t) => t[0]).join('');
    return candidate === full.acronym || candidate === withStop;
}

/** Name-only similarity in [0,1] between two normalize() results. */
function nameSimilarity(a, b) {
    if (!a.tokens.length || !b.tokens.length) return 0;
    if (a.key === b.key) return 1;

    const soft = softTokenMatch(a.tokens, b.tokens);
    const signals = [
        soft.dice,
        trigramDice(a.tokens.join(' '), b.tokens.join(' ')),
        trigramDice([...a.tokens].sort().join(' '), [...b.tokens].sort().join(' ')),
    ];

    // One name fully contained in the other ("Jazz Festival" ⊂ "Harare Jazz Festival").
    if (soft.coverage === 1 && soft.smallSize >= 2) {
        signals.push(0.7 + 0.25 * (soft.smallSize / soft.largeSize));
    }
    if (isAcronymOf(a, b) || isAcronymOf(b, a)) signals.push(0.9);

    const acronym = isAcronymOf(a, b) || isAcronymOf(b, a);
    let score = Math.max(...signals);
    if (soft.conflict && !acronym) {
        // Trigram overlap on the shared words would otherwise hide the conflict.
        score = soft.dice * 0.85;
    }

    // Explicit, different years in the names → different editions.
    if (a.years.length && b.years.length && !a.years.some((y) => b.years.includes(y))) {
        score *= 0.4;
    }
    return Math.min(1, score);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(`${String(d).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Days between two date ranges; 0 when they overlap. */
function dayGap(startA, endA, startB, endB) {
    const sA = toDate(startA);
    const sB = toDate(startB);
    if (!sA || !sB) return null;
    const eA = toDate(endA) || sA;
    const eB = toDate(endB) || sB;
    if (eA < sB) return Math.round((sB - eA) / DAY_MS);
    if (eB < sA) return Math.round((sA - eB) / DAY_MS);
    return 0;
}

const MATCH = {
    EXACT: 'exact',       // same canonical name and same dates — never create another
    LIKELY: 'likely',     // almost certainly the same event — creating needs confirmation
    SIMILAR: 'similar',   // worth showing in search results
};
const LIKELY_THRESHOLD = 0.78;
const SIMILAR_THRESHOLD = 0.45;
// Same name further apart than this is treated as a different edition.
const SAME_EVENT_MAX_GAP_DAYS = 3;

/**
 * Scores an existing event against what the photographer typed.
 * @param query  { name, start_date?, end_date?, venue?, city? }
 * @param event  { name, start_date, end_date, venue, city }
 * @returns { score, level|null, nameScore, dayGap }
 */
function scoreEvent(query, event, queryNorm = normalize(query.name), eventNorm = normalize(event.name)) {
    const nameScore = nameSimilarity(queryNorm, eventNorm);
    const gap = dayGap(query.start_date, query.end_date, event.start_date, event.end_date);

    let score = nameScore;
    if (gap !== null) {
        const dateScore = gap === 0 ? 1 : gap <= 1 ? 0.8 : gap <= SAME_EVENT_MAX_GAP_DAYS ? 0.5 : 0;
        score = 0.8 * nameScore + 0.2 * dateScore;
        if (gap > SAME_EVENT_MAX_GAP_DAYS) score = Math.min(score, SIMILAR_THRESHOLD + 0.1);
    }

    // Venue/city agreement nudges the score; it never makes a match on its own.
    const place = (x) => normalize(`${x.venue || ''} ${x.city || ''}`);
    const qp = place(query);
    const ep = place(event);
    if (qp.tokens.length && ep.tokens.length && nameScore >= SIMILAR_THRESHOLD) {
        score = Math.min(1, score + 0.06 * softTokenMatch(qp.tokens, ep.tokens).dice);
    }

    let level = null;
    if (queryNorm.key === eventNorm.key && (gap === null || gap === 0)) level = MATCH.EXACT;
    else if (score >= LIKELY_THRESHOLD) level = MATCH.LIKELY;
    else if (score >= SIMILAR_THRESHOLD) level = MATCH.SIMILAR;

    return { score: Math.round(score * 1000) / 1000, level, nameScore, dayGap: gap };
}

/** Ranks candidate events for a query; drops anything below SIMILAR. */
function rankEvents(query, events, limit = 10) {
    const queryNorm = normalize(query.name);
    return events
        .map((event) => ({ event, ...scoreEvent(query, event, queryNorm) }))
        .filter((r) => r.level)
        .sort((x, y) => y.score - x.score)
        .slice(0, limit);
}

module.exports = {
    MATCH,
    LIKELY_THRESHOLD,
    SIMILAR_THRESHOLD,
    normalize,
    phoneticCode,
    jaroWinkler,
    nameSimilarity,
    dayGap,
    scoreEvent,
    rankEvents,
};
