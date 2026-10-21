'use strict';
// Merchant onboarding as smatpay_whatsapp does it (register → activate by email link → sign in
// with emailed code → add business → keys), replacing the tese content-creator signup table.
// The previous table only ever held test rows.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.dropTable('merchants');
        await queryInterface.createTable('merchants', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            user_id: {
                type: Sequelize.INTEGER, allowNull: false, unique: true,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            // awaiting_activation → (signed in) needs_business → ready
            // existing_account: the email already had a SmatPay account; they sign in with it.
            status: { type: Sequelize.STRING(30), allowNull: false },
            smatpay_email: { type: Sequelize.STRING(191), allowNull: false },
            smatpay_user_id: { type: Sequelize.INTEGER, allowNull: true },
            // Verified sign-in token between the code and the business form (encrypted, short-lived).
            pending_token_enc: { type: Sequelize.TEXT, allowNull: true },
            pending_token_expires_at: { type: Sequelize.DATE, allowNull: true },
            // Set once the business exists on SmatPay.
            smatpay_account_id: { type: Sequelize.INTEGER, allowNull: true },
            merchant_id: { type: Sequelize.STRING(64), allowNull: true },
            keys_enc: { type: Sequelize.TEXT, allowNull: true },        // { sandbox: {key, apiKey}, production: {key, apiKey} }
            approved: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            title: { type: Sequelize.STRING(20), allowNull: true },
            account_type: { type: Sequelize.STRING(30), allowNull: true },
            trading_name: { type: Sequelize.STRING(150), allowNull: true },
            business_description: { type: Sequelize.STRING(255), allowNull: true },
            sector: { type: Sequelize.STRING(100), allowNull: true },
            sub_sector: { type: Sequelize.STRING(100), allowNull: true },
            registered_name: { type: Sequelize.STRING(150), allowNull: true },
            registration_number: { type: Sequelize.STRING(60), allowNull: true },
            trading_address: { type: Sequelize.STRING(255), allowNull: true },
            province: { type: Sequelize.STRING(100), allowNull: true },
            phone: { type: Sequelize.STRING(20), allowNull: true },
            contact_email: { type: Sequelize.STRING(191), allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });
    },
    down: async () => {
        throw new Error('Irreversible: recreate merchants with 20261018000001 if needed');
    },
};
