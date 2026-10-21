const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreEvent, normalize, MATCH } = require('../helpers/eventMatcher');

const existing = {
    name: 'Harare International Festival of the Arts 2026',
    start_date: '2026-10-20', end_date: '2026-10-25', venue: 'Harare Gardens', city: 'Harare',
};
const jazz = { name: 'Harare Jazz Festival', start_date: '2026-11-07', end_date: '2026-11-07', city: 'Harare' };

const level = (query, event) => scoreEvent(query, event).level;
const isDuplicate = (query, event) => [MATCH.EXACT, MATCH.LIKELY].includes(level(query, event));

test('exact canonical match despite case, punctuation, year and abbreviations', () => {
    assert.equal(level({ name: 'harare jazz fest', start_date: '2026-11-07' }, jazz), MATCH.EXACT);
    assert.equal(level({ name: 'Harare Jazz Festival!!', start_date: '2026-11-07' }, jazz), MATCH.EXACT);
    assert.equal(level({ name: 'Jazz Festival Harare' }, jazz), MATCH.EXACT); // word order
});

test('typos and sound-alike spellings are caught', () => {
    assert.ok(isDuplicate({ name: 'Harrare Jaz Festval', start_date: '2026-11-07' }, jazz));
    assert.ok(isDuplicate({ name: 'Harare Jazz Phestival', start_date: '2026-11-07' }, jazz));
});

test('acronyms match the full name', () => {
    assert.ok(isDuplicate({ name: 'HIFA', start_date: '2026-10-21' }, existing));
    assert.ok(isDuplicate({ name: 'HIFA 2026' }, existing));
});

test('shorter or longer variants of the same name on the same dates', () => {
    assert.ok(isDuplicate({ name: 'Harare Intl Festival of Arts', start_date: '2026-10-22' }, existing));
    assert.ok(isDuplicate({ name: 'Jazz Festival', start_date: '2026-11-07', city: 'Harare' }, jazz));
});

test('overlapping multi-day dates count as the same event', () => {
    assert.ok(isDuplicate({ name: 'Harare Intl Festival of the Arts', start_date: '2026-10-24', end_date: '2026-10-26' }, existing));
});

test('same name, a different edition (dates far apart or different year) is not a duplicate', () => {
    assert.ok(!isDuplicate({ name: 'Harare Jazz Festival', start_date: '2027-11-06' }, jazz));
    assert.ok(!isDuplicate({ name: 'HIFA 2025' }, existing));
    // ...but it is still shown as similar so the photographer can see it
    assert.equal(level({ name: 'Harare Jazz Festival', start_date: '2027-11-06' }, jazz), MATCH.SIMILAR);
});

test('different events with overlapping words are not duplicates', () => {
    assert.ok(!isDuplicate({ name: 'Bulawayo Jazz Festival', start_date: '2026-11-07' }, jazz));
    assert.ok(!isDuplicate({ name: 'Harare Food Festival', start_date: '2026-11-07' }, jazz));
    assert.ok(!isDuplicate({ name: 'Smith Wedding', start_date: '2026-11-07' }, { name: 'Smyth Graduation', start_date: '2026-11-07' }));
    assert.equal(level({ name: 'Cape Town Marathon' }, jazz), null);
});

test('weddings and private events with similar names', () => {
    const wedding = { name: "John & Mary's Wedding", start_date: '2026-12-12' };
    assert.equal(level({ name: 'John and Mary Wedding', start_date: '2026-12-12' }, wedding), MATCH.EXACT);
    assert.ok(isDuplicate({ name: 'Wedding of Mary & John', start_date: '2026-12-12' }, wedding));
    assert.ok(!isDuplicate({ name: 'John & Grace Wedding', start_date: '2026-12-12' }, wedding));
});

test('normalize produces stable keys', () => {
    assert.equal(normalize('The Harare Jazz Fest 2026').key, normalize('harare JAZZ festival').key);
    assert.deepEqual(normalize('Awards Night 2026').years, ['2026']);
    assert.equal(normalize('Café Olé').key, 'cafe ole');
});

test('a distinctive word on each side keeps events apart even on the same day', () => {
    const r = scoreEvent({ name: 'Harare Food Festival', start_date: '2026-11-07' }, jazz);
    assert.ok(r.score < 0.7, `score ${r.score} should be well below the duplicate threshold`);
    assert.equal(r.level, MATCH.SIMILAR); // still visible in search
});
