module.exports = {
    isProd: function () {
        return process.env.NODE_ENV === 'production';
    },

    appName: function () {
        return process.env.APP_NAME || 'SmatSnap';
    },

    jwtSecret: function () {
        const secret = this.isProd() ? process.env.PROD_SECRET : process.env.DEV_SECRET;
        if (!secret) {
            throw new Error('JWT secret is not configured (set DEV_SECRET / PROD_SECRET in .env)');
        }
        return secret;
    },

    s3Bucket: function () {
        return process.env.AWS_BUCKET;
    },

    s3BucketRegion: function () {
        return process.env.AWS_DEFAULT_REGION || 'af-south-1';
    },
};
