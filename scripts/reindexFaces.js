// Re-indexes every live media item with the current FACE_PROVIDER.
// Run after switching providers:  npm run faces:reindex
// (Embeddings / face ids from one provider can't be used by another.)
require('dotenv').config();
const { Op } = require('sequelize');
const models = require('../models');
const faces = require('../helpers/faces');

(async () => {
    const live = await models.media.findAll({
        where: { status: 'ready', expires_at: { [Op.gt]: new Date() } },
        attributes: ['id', 'event_id'],
    });
    await models.media_face.destroy({ where: { provider: { [Op.ne]: faces.name } } });
    // Photos are re-indexed by the retry job; videos are reprocessed (frames are temporary).
    await models.media.update({ face_status: 'failed' }, { where: { id: live.map((m) => m.id) } });
    console.log(`Queued ${live.length} item(s) for re-indexing with "${faces.name}". The API's retry job processes 10 every 10 minutes.`);
    process.exit(0);
})();
