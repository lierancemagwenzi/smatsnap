'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('media', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            event_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'events', key: 'id' }, onDelete: 'CASCADE',
            },
            creator_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            type: { type: Sequelize.ENUM('photo', 'video'), allowNull: false },
            original_key: { type: Sequelize.STRING(255), allowNull: false },
            thumb_key: { type: Sequelize.STRING(255), allowNull: true },
            preview_key: { type: Sequelize.STRING(255), allowNull: true },
            filename: { type: Sequelize.STRING(255), allowNull: true },
            mime_type: { type: Sequelize.STRING(100), allowNull: false },
            size_bytes: { type: Sequelize.BIGINT, allowNull: false },
            width: { type: Sequelize.INTEGER, allowNull: true },
            height: { type: Sequelize.INTEGER, allowNull: true },
            // Overrides the photographer's event price when set.
            price: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
            // pending → (client PUTs to S3) → uploaded → processing → ready | failed; deleted after expiry
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
            error: { type: Sequelize.STRING(255), allowNull: true },
            uploaded_at: { type: Sequelize.DATE, allowNull: true },
            expires_at: { type: Sequelize.DATE, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('media', ['event_id', 'status']);
        await queryInterface.addIndex('media', ['creator_id', 'event_id']);
        await queryInterface.addIndex('media', ['status', 'expires_at']);
    },
    down: async (queryInterface) => {
        await queryInterface.dropTable('media');
    }
};
