'use strict';
const multer = require('multer');

module.exports = function (app) {
    const authMiddleWare = require('../middleware/authentication');
    const userType = require('../middleware/user_type');
    const { faceSearchLimiter } = require('../middleware/rate_limit');
    const clientHandler = require('../handlers/client_handler');
    const paymentHandler = require('../handlers/PaymentHandler');

    const clientOnly = [authMiddleWare.authenticateToken, userType('client')];
    // Selfies stay in memory and are discarded after the search.
    const selfieUpload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024, files: 1 },
        fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
    }).single('selfie');
    const handleUpload = (req, res, next) => selfieUpload(req, res, (err) => {
        if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Selfie must be under 10 MB' : 'Invalid selfie upload' });
        next();
    });

    app.route('/api/client/events')
        .get(clientOnly, clientHandler.MyEvents);
    app.route('/api/client/events/:id')
        .get(clientOnly, clientHandler.EventDetail);
    app.route('/api/client/events/:id/face-search')
        .post(clientOnly, faceSearchLimiter, handleUpload, clientHandler.FaceSearch);
    app.route('/api/client/matches/:mediaId/hide')
        .post(clientOnly, clientHandler.HideMatch);

    // Checkout (each photographer's payment gateway) and purchases
    app.route('/api/client/checkout/quote')
        .post(clientOnly, paymentHandler.Quote);
    app.route('/api/client/checkout')
        .post(clientOnly, paymentHandler.Checkout);
    app.route('/api/client/orders')
        .get(clientOnly, paymentHandler.MyOrders);
    app.route('/api/client/orders/:id')
        .get(clientOnly, paymentHandler.OrderStatus);
    app.route('/api/client/purchases')
        .get(clientOnly, paymentHandler.MyPurchases);
    app.route('/api/client/purchases/:mediaId/download')
        .get(clientOnly, paymentHandler.Download);

    // Gateway callbacks (no user auth: webhooks are signature-checked, the return page is static)
    app.route('/api/payments/:provider/webhook')
        .post(paymentHandler.Webhook);
    app.route('/api/payments/:provider/return')
        .get(paymentHandler.ReturnPage);
};
