// Face matching, behind one interface so the provider can be swapped with
// FACE_PROVIDER=local|rekognition (re-index afterwards: `npm run faces:reindex`,
// since embeddings/face ids from one provider mean nothing to the other).
//
// Every provider implements:
//   name
//   indexMedia(media, images)   images: [{ buffer: JPEG, time: seconds|null }]
//                               → { faceCount }   (replaces any faces stored for the media)
//   search(eventId, selfieJpeg) → [{ mediaId, similarity: 0..1, times: [seconds] }]
//                               throws SelfieError when the selfie isn't usable
//   removeMedia(mediaIds)       forget faces of deleted/expired media
const { SelfieError } = require('./selfieError');

const PROVIDERS = {
    local: () => require('./localProvider'),
    rekognition: () => require('./rekognitionProvider'),
};

const name = (process.env.FACE_PROVIDER || 'local').toLowerCase();
if (!PROVIDERS[name]) throw new Error(`Unknown FACE_PROVIDER "${name}" (use: ${Object.keys(PROVIDERS).join(', ')})`);

module.exports = PROVIDERS[name]();
module.exports.SelfieError = SelfieError;
