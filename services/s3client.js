const { S3Client } = require('@aws-sdk/client-s3');
const env = require('../helpers/env');

// Media (event photos/videos) bucket client — wired up now so the upload phase
// can require it; nothing in the auth flow touches S3 yet.
module.exports = new S3Client({
    region: env.s3BucketRegion(),
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    },
    requestHandler: {
        requestTimeout: 10000
    }
});
