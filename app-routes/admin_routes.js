'use strict';

module.exports = function (app) {
    const authMiddleWare = require('../middleware/authentication');
    const userType = require('../middleware/user_type');
    const adminRole = require('../middleware/admin_role');
    const { authLimiter } = require('../middleware/rate_limit');
    const adminHandler = require('../handlers/AdminHandler');

    const adminOnly = [authMiddleWare.authenticateToken, userType('admin')];
    const superAdminOnly = [...adminOnly, adminRole('super_admin')];

    // Refresh, logout, get-account and forgot/reset password use the shared /api/auth routes.
    app.route('/api/admin/auth/login')
        .post(authLimiter, adminHandler.Login);

    app.route('/api/admin/stats')
        .get(adminOnly, adminHandler.Stats);
    app.route('/api/admin/system')
        .get(adminOnly, adminHandler.System);

    app.route('/api/admin/users')
        .get(adminOnly, adminHandler.Users);
    app.route('/api/admin/users/:id')
        .get(adminOnly, adminHandler.UserDetail);
    app.route('/api/admin/users/:id/status')
        .put(adminOnly, adminHandler.SetUserStatus);

    app.route('/api/admin/events')
        .get(adminOnly, adminHandler.Events);
    app.route('/api/admin/events/:id')
        .get(adminOnly, adminHandler.EventDetail);
    app.route('/api/admin/events/:id/status')
        .put(adminOnly, adminHandler.SetEventStatus);
    app.route('/api/admin/events/:id/media')
        .get(adminOnly, adminHandler.EventMedia);
    app.route('/api/admin/media/:id')
        .delete(adminOnly, adminHandler.DeleteMedia);

    app.route('/api/admin/orders')
        .get(adminOnly, adminHandler.Orders);
    app.route('/api/admin/orders/:id')
        .get(adminOnly, adminHandler.OrderDetail);
    app.route('/api/admin/orders/:id/recheck')
        .post(adminOnly, adminHandler.RecheckOrder);
    app.route('/api/admin/payouts')
        .get(adminOnly, adminHandler.Payouts);

    app.route('/api/admin/activity')
        .get(adminOnly, adminHandler.Activity);

    app.route('/api/admin/admins')
        .get(superAdminOnly, adminHandler.Admins)
        .post(superAdminOnly, adminHandler.CreateAdmin);
    app.route('/api/admin/admins/:id')
        .put(superAdminOnly, adminHandler.UpdateAdmin)
        .delete(superAdminOnly, adminHandler.DeleteAdmin);
};
