'use strict';
// Admin dashboard: admins are users with user_type 'admin' and an admin_role
// ('super_admin' manages other admins, 'admin' everything else). admin_actions is the
// audit log of what admins changed.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.changeColumn('users', 'user_type', {
            type: Sequelize.ENUM('creator', 'client', 'admin'), allowNull: false,
        });
        await queryInterface.addColumn('users', 'admin_role', { type: Sequelize.STRING(20), allowNull: true });

        await queryInterface.createTable('admin_actions', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            admin_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            action: { type: Sequelize.STRING(50), allowNull: false },       // e.g. user.suspend, event.hide
            target_type: { type: Sequelize.STRING(20), allowNull: true },   // user | event | media | order | admin
            target_id: { type: Sequelize.INTEGER, allowNull: true },
            details: { type: Sequelize.TEXT, allowNull: true },             // JSON
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('admin_actions', ['created_at']);
        await queryInterface.addIndex('admin_actions', ['target_type', 'target_id']);
    },
    down: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('admin_actions');
        await queryInterface.removeColumn('users', 'admin_role');
        await queryInterface.sequelize.query("DELETE FROM users WHERE user_type = 'admin'");
        await queryInterface.changeColumn('users', 'user_type', {
            type: Sequelize.ENUM('creator', 'client'), allowNull: false,
        });
    },
};
