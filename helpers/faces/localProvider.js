// Self-hosted provider: face-service/ (OpenCV YuNet + SFace) returns 128-d
// embeddings; we store them in media_faces and match with cosine similarity here.
const { QueryTypes } = require('sequelize');
const { pickSelfieFace, aggregate } = require('./selfie');

const SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:8611';
const TOKEN = process.env.FACE_SERVICE_TOKEN || '';
// Cosine similarity at/above which two faces count as the same person. OpenCV's
// reference value for SFace is 0.363; slightly stricter to keep false matches rare.
const THRESHOLD = Number(process.env.LOCAL_FACE_THRESHOLD || 0.42);
const BATCH = 20;
const DIM = 128;

const models = () => require('../../models');

async function embed(buffers) {
    const results = [];
    for (let i = 0; i < buffers.length; i += BATCH) {
        const form = new FormData();
        buffers.slice(i, i + BATCH).forEach((b, k) => form.append('images', new Blob([b], { type: 'image/jpeg' }), `${i + k}.jpg`));
        const res = await fetch(`${SERVICE_URL}/embed`, {
            method: 'POST',
            body: form,
            headers: TOKEN ? { 'X-Face-Token': TOKEN } : {},
            signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error(`face-service responded ${res.status}`);
        results.push(...(await res.json()).results);
    }
    return results;
}

// Buffers from MySQL/base64 aren't necessarily 4-byte aligned, so read the
// little-endian float32 values (as numpy writes them) instead of viewing the memory.
function toVector(buf) {
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = buf.readFloatLE(i * 4);
    return v;
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < DIM; i++) s += a[i] * b[i];
    return s;
}

module.exports = {
    name: 'local',

    async indexMedia(media, images) {
        const results = await embed(images.map((img) => img.buffer));
        const rows = [];
        results.forEach((r, i) => r.faces.forEach((f) => rows.push({
            media_id: media.id,
            event_id: media.event_id,
            provider: 'local',
            embedding: Buffer.from(f.embedding, 'base64'),
            frame_time: images[i].time,
        })));
        const { media_face, sequelize } = models();
        await sequelize.transaction(async (transaction) => {
            await media_face.destroy({ where: { media_id: media.id }, transaction });
            if (rows.length) await media_face.bulkCreate(rows, { transaction });
        });
        return { faceCount: rows.length };
    },

    async search(eventId, selfie) {
        const [result] = await embed([selfie]);
        const face = result.faces[pickSelfieFace(result.faces.map((f) => f.box))];
        const query = toVector(Buffer.from(face.embedding, 'base64'));

        // Brute force is fine at event scale: 50k faces × 128 dims is a few ms.
        const rows = await models().sequelize.query(
            "SELECT media_id, embedding, frame_time FROM media_faces WHERE event_id = ? AND provider = 'local'",
            { replacements: [eventId], type: QueryTypes.SELECT }
        );
        const hits = [];
        for (const row of rows) {
            const similarity = dot(query, toVector(row.embedding));
            if (similarity >= THRESHOLD) hits.push({ mediaId: row.media_id, similarity, time: row.frame_time });
        }
        return aggregate(hits);
    },

    async removeMedia(mediaIds) {
        if (mediaIds.length) await models().media_face.destroy({ where: { media_id: mediaIds } });
    },
};
