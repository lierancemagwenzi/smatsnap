'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('users', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            name: { type: Sequelize.STRING(100), allowNull: false },
            lastname: { type: Sequelize.STRING(100), allowNull: false },
            email: { type: Sequelize.STRING(191), allowNull: false, unique: true },
            user_type: { type: Sequelize.ENUM('creator', 'client'), allowNull: false },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'active' },
            password: { type: Sequelize.STRING, allowNull: false },
            email_verified_at: { type: Sequelize.DATE, allowNull: true },
            otp_hash: { type: Sequelize.STRING, allowNull: true },
            otp_purpose: { type: Sequelize.STRING(20), allowNull: true },
            otp_expires_at: { type: Sequelize.DATE, allowNull: true },
            otp_attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            otp_sent_at: { type: Sequelize.DATE, allowNull: true },
            refresh_token_hash: { type: Sequelize.STRING, allowNull: true },
            last_login_at: { type: Sequelize.DATE, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
        await queryInterface.addIndex('users', ['user_type']);
    },
    down: async (queryInterface) => {
        await queryInterface.dropTable('users');
    }
};
