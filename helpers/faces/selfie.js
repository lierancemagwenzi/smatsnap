// Provider-independent selfie checks on detected face boxes [x, y, w, h].
const { SelfieError } = require('./selfieError');

const MIN_SELFIE_FACE_PX = 80;

/** Returns the index of the face to search with, or throws SelfieError. */
function pickSelfieFace(boxes) {
    if (!boxes.length) throw SelfieError.noFace();
    const areas = boxes.map((b) => b[2] * b[3]);
    const order = areas.map((a, i) => i).sort((a, b) => areas[b] - areas[a]);
    // A second face nearly as big as the first: someone is sharing the frame.
    if (order.length > 1 && areas[order[1]] > areas[order[0]] * 0.35) throw SelfieError.multipleFaces();
    const main = boxes[order[0]];
    if (Math.min(main[2], main[3]) < MIN_SELFIE_FACE_PX) throw SelfieError.tooSmall();
    return order[0];
}

/** Collapses per-face hits into one result per media item. */
function aggregate(hits) {
    const byMedia = new Map();
    for (const { mediaId, similarity, time } of hits) {
        const current = byMedia.get(mediaId) || { mediaId, similarity: 0, times: [] };
        current.similarity = Math.max(current.similarity, similarity);
        if (time !== null && time !== undefined) current.times.push(Math.round(time));
        byMedia.set(mediaId, current);
    }
    return [...byMedia.values()]
        .map((m) => ({ ...m, times: [...new Set(m.times)].sort((a, b) => a - b).slice(0, 20) }))
        .sort((a, b) => b.similarity - a.similarity);
}

module.exports = { pickSelfieFace, aggregate };
