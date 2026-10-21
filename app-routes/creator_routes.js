'use strict';

module.exports = function (app) {
    const authMiddleWare = require('../middleware/authentication');
    const userType = require('../middleware/user_type');
    const creatorHandler = require('../handlers/creatorHandler');

    const creatorOnly = [authMiddleWare.authenticateToken, userType('creator')];

    // Express 5 has no regex params, so reject non-numeric ids up front.
    app.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ message: 'Not found' })));

    app.route('/api/creator/dashboard')
        .get(creatorOnly, creatorHandler.Dashboard);

    // Payout account with the gateway of the photographer's country (for accounts created before payments)
    app.route('/api/creator/payout')
        .get(creatorOnly, creatorHandler.GetPayout)
        .post(creatorOnly, creatorHandler.SetupPayout);

    // Sales (our order ledger + gateway balance where available)
    app.route('/api/creator/sales/summary')
        .get(creatorOnly, creatorHandler.SalesSummary);
    app.route('/api/creator/sales/transactions')
        .get(creatorOnly, creatorHandler.SalesTransactions);

    app.route('/api/creator/events')
        .get(creatorOnly, creatorHandler.MyEvents)
        .post(creatorOnly, creatorHandler.CreateEvent);
    app.route('/api/creator/events/:id')
        .get(creatorOnly, creatorHandler.EventDetail);
    app.route('/api/creator/events/:id/join')
        .post(creatorOnly, creatorHandler.JoinEvent);
    app.route('/api/creator/events/:id/price')
        .put(creatorOnly, creatorHandler.UpdateEventPrice);
    app.route('/api/creator/events/:id/media/upload-urls')
        .post(creatorOnly, creatorHandler.CreateUploadUrls);

    app.route('/api/creator/media/:id/parts')
        .get(creatorOnly, creatorHandler.ListUploadedParts)
        .post(creatorOnly, creatorHandler.CreatePartUrls);
    app.route('/api/creator/media/:id/complete')
        .post(creatorOnly, creatorHandler.CompleteUpload);
    app.route('/api/creator/media/:id/price')
        .put(creatorOnly, creatorHandler.UpdateMediaPrice);
    app.route('/api/creator/media/:id')
        .delete(creatorOnly, creatorHandler.DeleteMedia);
};
