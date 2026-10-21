// Background work for uploaded media (scheduled from app.js, like tese-backend's jobs):
//  - processUploadedMedia: photo → thumbnails + watermarked preview + face index;
//                          video → poster, watermarked preview clip, sampled frames → face index
//  - retryFaceIndexing:    re-indexes media whose face indexing failed (e.g. face service down)
//  - expireMedia:          removes media (S3 + faces) once its 7-day window ends, and cleans up
//                          uploads that were started but never completed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { Op } = require('sequelize');
const amazonHelper = require('./amazonHelper');
const videoTools = require('./videoTools');
const faces = require('./faces');
const env = require('./env');
const { photoTakenAt, videoTakenAt } = require('./capturedAt');

const THUMB_SIZE = 480;            // clean, for the photographer
const PREVIEW_THUMB_SIZE = 600;    // watermarked, for client grids
const PREVIEW_SIZE = 1600;         // watermarked, for the client viewer
const FACE_SOURCE_SIZE = 1600;     // unwatermarked copy sent to the face provider
const BATCH_SIZE = 3;
const ABANDONED_UPLOAD_HOURS = 24;

let processing = false;
let retrying = false;

function watermarkSvg(width, height) {
    const label = `${env.appName().toUpperCase()} · PREVIEW`;
    const fontSize = Math.max(16, Math.round(Math.min(width, height) / 18));
    const stepX = fontSize * 14;
    const stepY = fontSize * 5;
    return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <pattern id="wm" width="${stepX}" height="${stepY}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
      <text x="0" y="${fontSize}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700"
            fill="#ffffff" fill-opacity="0.32" stroke="#000000" stroke-opacity="0.12" stroke-width="1">${label}</text>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#wm)"/>
</svg>`);
}

async function watermarked(base, size, quality) {
    const resized = await base.clone()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
    return sharp(resized.data)
        .composite([{ input: watermarkSvg(resized.info.width, resized.info.height), top: 0, left: 0 }])
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
}

function derivedKey(item, folder, ext) {
    return item.original_key.replace('/originals/', `/${folder}/`).replace(/\.[^.]+$/, ext);
}

/** Clean thumb + watermarked thumb/preview from any still image (photo or video poster). */
async function stillDerivatives(item, imageBuffer, { previewIsClip }) {
    const base = sharp(imageBuffer, { failOn: 'none' }).rotate(); // honour EXIF orientation
    const thumb = await base.clone()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75, mozjpeg: true })
        .toBuffer();
    const previewThumb = await watermarked(base, PREVIEW_THUMB_SIZE, 72);

    const keys = { thumb_key: derivedKey(item, 'thumbs', '.jpg'), preview_thumb_key: derivedKey(item, 'preview-thumbs', '.jpg') };
    await amazonHelper.put(keys.thumb_key, thumb, 'image/jpeg');
    await amazonHelper.put(keys.preview_thumb_key, previewThumb, 'image/jpeg');
    if (!previewIsClip) {
        keys.preview_key = derivedKey(item, 'previews', '.jpg');
        await amazonHelper.put(keys.preview_key, await watermarked(base, PREVIEW_SIZE, 80), 'image/jpeg');
    }
    return { base, keys };
}

async function indexFaces(item, images) {
    try {
        const { faceCount } = await faces.indexMedia(item, images);
        return { face_status: faceCount ? 'indexed' : 'none', face_count: faceCount };
    } catch (err) {
        // The media is still usable; retryFaceIndexing picks it up again later.
        console.error(`[media] face indexing #${item.id} failed:`, err.message);
        return { face_status: 'failed', face_count: 0 };
    }
}

async function photoFaceSource(base) {
    return base.clone()
        .resize(FACE_SOURCE_SIZE, FACE_SOURCE_SIZE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
}

async function processPhoto(item) {
    const original = await amazonHelper.getBuffer(item.original_key);
    const { base, keys } = await stillDerivatives(item, original, { previewIsClip: false });
    const meta = await base.metadata();
    const portrait = (meta.orientation || 1) >= 5;
    const faceResult = await indexFaces(item, [{ buffer: await photoFaceSource(base), time: null }]);
    return {
        ...keys,
        ...faceResult,
        taken_at: await photoTakenAt(original),
        width: portrait ? meta.height : meta.width,
        height: portrait ? meta.width : meta.height,
    };
}

async function processVideo(item) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `media-${item.id}-`));
    try {
        const source = path.join(dir, 'source');
        await amazonHelper.downloadToFile(item.original_key, source);
        const info = await videoTools.probe(source);

        const poster = await videoTools.posterFrame(source, info, path.join(dir, 'poster.jpg'));
        const { keys } = await stillDerivatives(item, poster, { previewIsClip: true });

        const size = videoTools.previewSize(info);
        const watermarkPng = path.join(dir, 'wm.png');
        await sharp(watermarkSvg(size.width, size.height)).png().toFile(watermarkPng);
        const clip = await videoTools.previewClip(source, info, watermarkPng, path.join(dir, 'preview.mp4'));
        keys.preview_key = derivedKey(item, 'previews', '.mp4');
        await amazonHelper.put(keys.preview_key, clip, 'video/mp4');

        const framesDir = path.join(dir, 'frames');
        fs.mkdirSync(framesDir);
        const frames = await videoTools.sampleFrames(source, info, framesDir);
        const faceResult = await indexFaces(item, frames);

        return {
            ...keys, ...faceResult,
            width: info.width, height: info.height, duration_seconds: info.duration,
            taken_at: videoTakenAt(info.header),
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

exports.processUploadedMedia = async function () {
    if (processing) return; // previous tick still running
    processing = true;
    const models = require('../models');
    try {
        const batch = await models.media.findAll({
            where: { status: 'uploaded' },
            order: [['uploaded_at', 'ASC']],
            limit: BATCH_SIZE,
        });
        for (const item of batch) {
            // Claim it atomically so a second API instance can't process it too.
            const [claimed] = await models.media.update(
                { status: 'processing' },
                { where: { id: item.id, status: 'uploaded' } }
            );
            if (!claimed) continue;
            try {
                const result = item.type === 'video' ? await processVideo(item) : await processPhoto(item);
                await item.update({ ...result, status: 'ready', error: null });
            } catch (err) {
                console.error(`[media] processing #${item.id} failed:`, err.message);
                await item.update({
                    status: 'failed',
                    error: (item.type === 'video' && /readable video/.test(err.message)
                        ? 'This file could not be read as a video'
                        : String(err.message)).slice(0, 250),
                });
            }
        }
    } catch (err) {
        console.error('[media] processUploadedMedia error:', err.message);
    } finally {
        processing = false;
    }
};

exports.retryFaceIndexing = async function () {
    if (retrying) return;
    retrying = true;
    const models = require('../models');
    try {
        const failed = await models.media.findAll({
            where: { status: 'ready', face_status: 'failed', expires_at: { [Op.gt]: new Date() } },
            limit: 10,
        });
        for (const item of failed) {
            if (item.type === 'video') {
                // Frames are temporary, so reprocess the whole video.
                await item.update({ status: 'uploaded' });
                continue;
            }
            const base = sharp(await amazonHelper.getBuffer(item.original_key), { failOn: 'none' }).rotate();
            await item.update(await indexFaces(item, [{ buffer: await photoFaceSource(base), time: null }]));
        }
    } catch (err) {
        console.error('[media] retryFaceIndexing error:', err.message);
    } finally {
        retrying = false;
    }
};

/** Deletes media files and face data; used by expiry and by explicit deletes. */
async function purge(items) {
    for (const m of items.filter((m) => m.upload_id)) {
        await amazonHelper.abortMultipartUpload(m.original_key, m.upload_id);
    }
    await faces.removeMedia(items.map((m) => m.id));
    // DeleteObjects accepts up to 1000 keys per call: 200 rows × 5 keys each.
    for (let i = 0; i < items.length; i += 200) {
        const chunk = items.slice(i, i + 200);
        await amazonHelper.deleteKeys(chunk.flatMap((m) => [m.original_key, m.thumb_key, m.preview_key, m.preview_thumb_key]));
    }
}
exports.purge = purge;

exports.expireMedia = async function () {
    const models = require('../models');
    const { activePurchaseMediaIds } = require('./paymentTracker');
    try {
        const abandonedBefore = new Date(Date.now() - ABANDONED_UPLOAD_HOURS * 60 * 60 * 1000);
        const due = await models.media.findAll({
            where: {
                [Op.or]: [
                    { status: { [Op.notIn]: ['pending', 'deleted'] }, expires_at: { [Op.lte]: new Date() } },
                    { status: 'pending', created_at: { [Op.lte]: abandonedBefore } },
                ],
            },
            limit: 500,
        });
        if (!due.length) return;

        // Bought media stays downloadable for its buyers until their download period ends, but
        // it leaves the event (expires_at is past, so nobody new sees it) and its faces go now.
        const owed = await activePurchaseMediaIds(due.map((m) => m.id));
        const keep = due.filter((m) => owed.has(m.id) && m.face_count > 0);
        if (keep.length) {
            await faces.removeMedia(keep.map((m) => m.id));
            await models.media.update({ face_count: 0 }, { where: { id: keep.map((m) => m.id) } });
        }
        const remove = due.filter((m) => !owed.has(m.id));
        if (!remove.length) return;
        await purge(remove);
        await models.media.update(
            { status: 'deleted', upload_id: null, face_count: 0 },
            { where: { id: remove.map((m) => m.id) } }
        );
        console.log(`[media] expired ${remove.length} item(s)`);
    } catch (err) {
        console.error('[media] expireMedia error:', err.message);
    }
};
