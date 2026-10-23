// Lets the photographer studio (web) upload straight to the media bucket: browsers need a CORS
// rule for the presigned PUTs (single files and multipart parts). The app doesn't need this.
//   npm run s3:cors                      # shows the current rules
//   npm run s3:cors -- --apply           # sets them for WEB_ORIGINS (comma-separated)
// WEB_ORIGINS defaults to the hosted site + local vite dev/preview.
require('dotenv').config();
const { GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const s3 = require('../services/s3client');
const env = require('../helpers/env');

const origins = (process.env.WEB_ORIGINS || 'https://smatsnap.strima.co.za,http://localhost:5173,http://localhost:4173')
    .split(',').map((o) => o.trim()).filter(Boolean);

const rules = [{
    AllowedOrigins: origins,
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    AllowedHeaders: ['Content-Type'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3600,
}];

(async () => {
    const Bucket = env.s3Bucket();
    if (process.argv.includes('--apply')) {
        await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
        console.log(`CORS set on ${Bucket} for:`, origins.join(', '));
        return;
    }
    try {
        const current = await s3.send(new GetBucketCorsCommand({ Bucket }));
        console.log(`${Bucket} CORS:`, JSON.stringify(current.CORSRules, null, 2));
    } catch (error) {
        if (error.name !== 'NoSuchCORSConfiguration') throw error;
        console.log(`${Bucket} has no CORS rules — web uploads will fail. Run with --apply.`);
    }
})().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
