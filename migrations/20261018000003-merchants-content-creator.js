'use strict';
// Back to tese-style registration (POST /auth/content-creator/signup with a SmatPay product
// code, which returns the merchant and its keys at once). Replaces the smatpay_whatsapp-style
// onboarding table; it only ever held test rows.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('merchants');
        await queryInterface.createTable('merchants', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            user_id: {
                type: Sequelize.INTEGER, allowNull: false, unique: true,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'ready' },
            product_code: { type: Sequelize.STRING(40), allowNull: false },          // which SmatPay product registered it
            smatpay_account_id: { type: Sequelize.INTEGER, allowNull: false },       // tese's "the_id"
            merchant_id: { type: Sequelize.STRING(64), allowNull: false },           // accountMerchantId
            keys_enc: { type: Sequelize.TEXT, allowNull: false },                    // { sandbox: {key, apiKey}, production: {key, apiKey} }
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
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
    },
    down: async () => {
        throw new Error('Irreversible: recreate merchants with 20261018000002 if needed');
    },
};
