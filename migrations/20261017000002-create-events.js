'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('events', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            name: { type: Sequelize.STRING(150), allowNull: false },
            // Matching columns maintained from `name` by helpers/eventMatcher.normalize().
            name_key: { type: Sequelize.STRING(191), allowNull: false },
            name_phonetic: { type: Sequelize.STRING(191), allowNull: false },
            name_acronym: { type: Sequelize.STRING(30), allowNull: false },
            venue: { type: Sequelize.STRING(150), allowNull: true },
            city: { type: Sequelize.STRING(100), allowNull: true },
            start_date: { type: Sequelize.DATEONLY, allowNull: false },
            end_date: { type: Sequelize.DATEONLY, allowNull: false },
            code: { type: Sequelize.STRING(12), allowNull: false, unique: true },
            created_by: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT',
            },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active' },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        // Last line of defence against two photographers creating the same event at once.
        await queryInterface.addIndex('events', ['name_key', 'start_date'], { unique: true, name: 'events_name_key_start_date' });
        await queryInterface.addIndex('events', ['start_date']);
        await queryInterface.addIndex('events', ['name_acronym']);

        await queryInterface.createTable('event_photographers', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            event_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'events', key: 'id' }, onDelete: 'CASCADE',
            },
            creator_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            // Default price for this photographer's media in this event.
            price: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
            currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'USD' },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('event_photographers', ['event_id', 'creator_id'], { unique: true });
        await queryInterface.addIndex('event_photographers', ['creator_id']);
    },
    down: async (queryInterface) => {
        await queryInterface.dropTable('event_photographers');
        await queryInterface.dropTable('events');
    }
};
