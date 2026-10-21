const {
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectsCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    ListPartsCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const s3 = require('../services/s3client');
const env = require('./env');

// S3 refuses presigned URLs valid for more than 7 days.
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const hours = (name, fallback) => Math.min(MAX_TTL_SECONDS, Math.round(Number(process.env[name] || fallback) * 3600));

// Single-PUT URLs are issued for a whole batch at once, and a phone may only get to
// the last file of 50 much later — so they live long. Part URLs are fetched right
// before each part is sent, so a shorter window is plenty.
const UPLOAD_URL_TTL_SECONDS = hours('UPLOAD_URL_TTL_HOURS', 24);
const PART_URL_TTL_SECONDS = hours('PART_URL_TTL_HOURS', 6);
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

const bucket = () => env.s3Bucket();

module.exports = {
    UPLOAD_URL_TTL_SECONDS,
    PART_URL_TTL_SECONDS,

    // The client PUTs the file straight to S3 — it never streams through this API.
    // Content-Type and Content-Length are part of the signature, so the upload must
    // match what the client declared.
    presignUpload: (key, contentType, sizeBytes) => getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: sizeBytes }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS }
    ),

    presignDownload: (key, { filename, expiresIn = DOWNLOAD_URL_TTL_SECONDS } = {}) => {
        if (!key) return null;
        return getSignedUrl(
            s3,
            new GetObjectCommand({
                Bucket: bucket(),
                Key: key,
                ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"` } : {}),
            }),
            { expiresIn }
        );
    },

    // ── Multipart (large files) ──────────────────────────────────────────────
    createMultipartUpload: async (key, contentType) => {
        const res = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }));
        return res.UploadId;
    },

    // Signed for the exact part length, so a short/oversized part is rejected by S3.
    presignPart: (key, uploadId, partNumber, sizeBytes) => getSignedUrl(
        s3,
        new UploadPartCommand({
            Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: sizeBytes,
        }),
        { expiresIn: PART_URL_TTL_SECONDS }
    ),

    // All parts S3 has received so far: [{ PartNumber, ETag, Size }]. Throws NoSuchUpload
    // once the upload was completed or aborted.
    listParts: async (key, uploadId) => {
        const parts = [];
        let marker;
        do {
            const res = await s3.send(new ListPartsCommand({
                Bucket: bucket(), Key: key, UploadId: uploadId, PartNumberMarker: marker,
            }));
            parts.push(...(res.Parts || []));
            marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
        } while (marker);
        return parts;
    },

    completeMultipartUpload: (key, uploadId, parts) => s3.send(new CompleteMultipartUploadCommand({
        Bucket: bucket(),
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
    })),

    abortMultipartUpload: async (key, uploadId) => {
        try {
            await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
        } catch (err) {
            if (err.name !== 'NoSuchUpload') throw err; // already completed/aborted
        }
    },

    // ── Objects ──────────────────────────────────────────────────────────────
    // Returns null when the object doesn't exist.
    head: async (key) => {
        try {
            return await s3.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
        } catch (err) {
            if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return null;
            throw err;
        }
    },

    getBuffer: async (key) => {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        return Buffer.from(await res.Body.transformToByteArray());
    },

    // Streams an object to disk (large videos never sit in memory).
    downloadToFile: async (key, filePath) => {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        await pipeline(res.Body, fs.createWriteStream(filePath));
    },

    put: (key, body, contentType) => s3.send(new PutObjectCommand({
        Bucket: bucket(), Key: key, Body: body, ContentType: contentType,
    })),

    deleteKeys: async (keys) => {
        const objects = keys.filter(Boolean).map((Key) => ({ Key }));
        if (!objects.length) return;
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: objects, Quiet: true } }));
    },
};
