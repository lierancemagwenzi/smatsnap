// AWS Rekognition provider (one face collection per event). Rekognition isn't
// offered in af-south-1, so images are sent as bytes to REKOGNITION_REGION.
const {
    RekognitionClient,
    CreateCollectionCommand,
    IndexFacesCommand,
    DetectFacesCommand,
    SearchFacesByImageCommand,
    DeleteFacesCommand,
} = require('@aws-sdk/client-rekognition');
const { pickSelfieFace, aggregate } = require('./selfie');

const client = new RekognitionClient({
    region: process.env.REKOGNITION_REGION || 'us-east-1',
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
const PREFIX = process.env.REKOGNITION_COLLECTION_PREFIX || 'lumina-dev';
const THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 90); // percent

const models = () => require('../../models');
const collectionId = (eventId) => `${PREFIX}-event-${eventId}`;

async function ensureCollection(eventId) {
    try {
        await client.send(new CreateCollectionCommand({ CollectionId: collectionId(eventId) }));
    } catch (err) {
        if (err.name !== 'ResourceAlreadyExistsException') throw err;
    }
}

async function deleteFaceIds(eventId, faceIds) {
    for (let i = 0; i < faceIds.length; i += 4096) {
        try {
            await client.send(new DeleteFacesCommand({ CollectionId: collectionId(eventId), FaceIds: faceIds.slice(i, i + 4096) }));
        } catch (err) {
            if (err.name !== 'ResourceNotFoundException') throw err;
        }
    }
}

module.exports = {
    name: 'rekognition',

    async indexMedia(media, images) {
        const { media_face } = models();
        await ensureCollection(media.event_id);
        const previous = await media_face.findAll({ where: { media_id: media.id, provider: 'rekognition' } });
        await deleteFaceIds(media.event_id, previous.map((f) => f.face_id));

        const rows = [];
        for (const img of images) {
            const res = await client.send(new IndexFacesCommand({
                CollectionId: collectionId(media.event_id),
                Image: { Bytes: img.buffer },
                ExternalImageId: `m${media.id}`,
                MaxFaces: 100,
                QualityFilter: 'AUTO',
            }));
            for (const record of res.FaceRecords || []) {
                rows.push({ media_id: media.id, event_id: media.event_id, provider: 'rekognition', face_id: record.Face.FaceId, frame_time: img.time });
            }
        }
        await media_face.destroy({ where: { media_id: media.id } });
        if (rows.length) await media_face.bulkCreate(rows);
        return { faceCount: rows.length };
    },

    async search(eventId, selfie) {
        // Same selfie rules as the local provider (one clear face).
        const detected = await client.send(new DetectFacesCommand({ Image: { Bytes: selfie } }));
        const meta = await require('sharp')(selfie).metadata();
        pickSelfieFace((detected.FaceDetails || []).map((d) => [
            d.BoundingBox.Left * meta.width, d.BoundingBox.Top * meta.height,
            d.BoundingBox.Width * meta.width, d.BoundingBox.Height * meta.height,
        ]));

        let res;
        try {
            res = await client.send(new SearchFacesByImageCommand({
                CollectionId: collectionId(eventId), Image: { Bytes: selfie }, FaceMatchThreshold: THRESHOLD, MaxFaces: 4096,
            }));
        } catch (err) {
            if (err.name === 'ResourceNotFoundException') return []; // nothing indexed for this event yet
            throw err;
        }
        const matches = res.FaceMatches || [];
        if (!matches.length) return [];
        const rows = await models().media_face.findAll({
            where: { face_id: matches.map((m) => m.Face.FaceId), provider: 'rekognition' },
            raw: true,
        });
        const byFace = new Map(rows.map((r) => [r.face_id, r]));
        return aggregate(matches
            .filter((m) => byFace.has(m.Face.FaceId))
            .map((m) => ({ mediaId: byFace.get(m.Face.FaceId).media_id, similarity: m.Similarity / 100, time: byFace.get(m.Face.FaceId).frame_time })));
    },

    async removeMedia(mediaIds) {
        if (!mediaIds.length) return;
        const { media_face } = models();
        const rows = await media_face.findAll({ where: { media_id: mediaIds, provider: 'rekognition' }, raw: true });
        const byEvent = new Map();
        rows.forEach((r) => byEvent.set(r.event_id, [...(byEvent.get(r.event_id) || []), r.face_id]));
        for (const [eventId, ids] of byEvent) await deleteFaceIds(eventId, ids);
        await media_face.destroy({ where: { media_id: mediaIds } });
    },
};
