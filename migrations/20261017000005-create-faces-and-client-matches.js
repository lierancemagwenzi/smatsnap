'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        // Watermarked small thumbnail for client grids (`thumb_key` stays clean, for the photographer).
        await queryInterface.addColumn('media', 'preview_thumb_key', { type: Sequelize.STRING(255), allowNull: true });
        // pending → indexed | none (no faces found) | failed (retried by a job)
        await queryInterface.addColumn('media', 'face_status', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' });
        await queryInterface.addColumn('media', 'face_count', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });

        // Faces indexed in the event's Rekognition collection, so they can be removed on delete/expiry.
        await queryInterface.createTable('media_faces', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            media_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'media', key: 'id' }, onDelete: 'CASCADE',
            },
            event_id: { type: Sequelize.INTEGER, allowNull: false },
            face_id: { type: Sequelize.STRING(64), allowNull: false },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('media_faces', ['media_id']);
        await queryInterface.addIndex('media_faces', ['event_id']);

        // Events a client searched with a selfie (the selfie itself is never stored).
        await queryInterface.createTable('client_events', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            client_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            event_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'events', key: 'id' }, onDelete: 'CASCADE',
            },
            last_searched_at: { type: Sequelize.DATE, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('client_events', ['client_id', 'event_id'], { unique: true });

        // Media a client's face matched. `hidden` = the client said "not me".
        await queryInterface.createTable('client_matches', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            client_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            event_id: { type: Sequelize.INTEGER, allowNull: false },
            media_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'media', key: 'id' }, onDelete: 'CASCADE',
            },
            similarity: { type: Sequelize.FLOAT, allowNull: false },
            hidden: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('client_matches', ['client_id', 'media_id'], { unique: true });
        await queryInterface.addIndex('client_matches', ['client_id', 'event_id']);
    },
    down: async (queryInterface) => {
        await queryInterface.dropTable('client_matches');
        await queryInterface.dropTable('client_events');
        await queryInterface.dropTable('media_faces');
        await queryInterface.removeColumn('media', 'face_count');
        await queryInterface.removeColumn('media', 'face_status');
        await queryInterface.removeColumn('media', 'preview_thumb_key');
    }
};
