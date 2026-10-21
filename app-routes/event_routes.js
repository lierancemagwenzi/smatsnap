'use strict';

// Event lookups shared by photographers and (later) clients.
module.exports = function (app) {
    const authMiddleWare = require('../middleware/authentication');
    const eventHandler = require('../handlers/EventHandler');

    app.route('/api/events/search')
        .get(authMiddleWare.authenticateToken, eventHandler.SearchEvents);
};
