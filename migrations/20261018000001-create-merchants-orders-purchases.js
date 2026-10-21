'use strict';
const ts = (Sequelize) => ({
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
});

module.exports = {
    up: async (queryInterface, Sequelize) => {
        // A photographer's SmatPay merchant account (like tese-backend's `merchants`, keys encrypted).
        await queryInterface.createTable('merchants', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            user_id: {
                type: Sequelize.INTEGER, allowNull: false, unique: true,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            smatpay_account_id: { type: Sequelize.INTEGER, allowNull: false },     // SmatPay account id ("the_id")
            merchant_id: { type: Sequelize.STRING(64), allowNull: false },          // accountMerchantId
            // AES-256-GCM JSON: { sandbox: {key, apiKey}, production: {key, apiKey} }
            keys_enc: { type: Sequelize.TEXT, allowNull: false },
            approved: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            title: { type: Sequelize.STRING(20), allowNull: true },
            gender: { type: Sequelize.STRING(20), allowNull: true },
            date_of_birth: { type: Sequelize.DATEONLY, allowNull: true },
            phone: { type: Sequelize.STRING(20), allowNull: false },
            trading_name: { type: Sequelize.STRING(150), allowNull: false },
            business_description: { type: Sequelize.STRING(255), allowNull: false },
            trading_address: { type: Sequelize.STRING(255), allowNull: false },
            province: { type: Sequelize.STRING(100), allowNull: false },
            country: { type: Sequelize.STRING(100), allowNull: false },
            ...ts(Sequelize),
        });

        // One order = one SmatPay payment to one photographer.
        await queryInterface.createTable('orders', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            reference: { type: Sequelize.STRING(64), allowNull: false, unique: true },
            client_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            creator_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            event_id: { type: Sequelize.INTEGER, allowNull: false },
            wallet: { type: Sequelize.STRING(20), allowNull: false },
            payer_mobile: { type: Sequelize.STRING(20), allowNull: true },
            currency: { type: Sequelize.STRING(3), allowNull: false },
            subtotal: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
            fee: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
            total: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
            // PENDING → PAID | FAILED | CANCELLED | EXPIRED
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'PENDING' },
            provider_status: { type: Sequelize.STRING(40), allowNull: true },
            payment_code: { type: Sequelize.STRING(100), allowNull: true },     // InnBucks
            redirect_url: { type: Sequelize.TEXT, allowNull: true },            // cards / ZimSwitch
            paid_at: { type: Sequelize.DATE, allowNull: true },
            last_checked_at: { type: Sequelize.DATE, allowNull: true },
            ...ts(Sequelize),
        });
        await queryInterface.addIndex('orders', ['status', 'created_at']);
        await queryInterface.addIndex('orders', ['client_id']);
        await queryInterface.addIndex('orders', ['creator_id', 'status']);

        await queryInterface.createTable('order_items', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            order_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE',
            },
            media_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'media', key: 'id' }, onDelete: 'CASCADE',
            },
            price: { type: Sequelize.DECIMAL(10, 2), allowNull: false },     // price charged, fixed at checkout
            ...ts(Sequelize),
        });
        await queryInterface.addIndex('order_items', ['order_id']);

        // Download rights, created when an order is PAID.
        await queryInterface.createTable('purchases', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            client_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            media_id: {
                type: Sequelize.INTEGER, allowNull: false,
                references: { model: 'media', key: 'id' }, onDelete: 'CASCADE',
            },
            order_id: { type: Sequelize.INTEGER, allowNull: false },
            download_until: { type: Sequelize.DATE, allowNull: false },
            ...ts(Sequelize),
        });
        await queryInterface.addIndex('purchases', ['client_id', 'media_id'], { unique: true });
        await queryInterface.addIndex('purchases', ['media_id', 'download_until']);
    },
    down: async (queryInterface) => {
        await queryInterface.dropTable('purchases');
        await queryInterface.dropTable('order_items');
        await queryInterface.dropTable('orders');
        await queryInterface.dropTable('merchants');
    }
};
