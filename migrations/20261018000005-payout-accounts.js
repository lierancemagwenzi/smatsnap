'use strict';
// Payments become gateway-independent: a photographer's payout account belongs to the gateway
// of their country (SmatPay for Zimbabwe, Paystack for ZA/NG/GH/KE, …). SmatPay merchants are
// copied over unchanged (keys stay encrypted), then the SmatPay-only table is dropped.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.createTable('payout_accounts', {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            user_id: {
                type: Sequelize.INTEGER, allowNull: false, unique: true,
                references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
            },
            provider: { type: Sequelize.STRING(30), allowNull: false },          // smatpay | paystack | …
            country: { type: Sequelize.STRING(2), allowNull: false },            // ISO 3166-1 alpha-2
            currency: { type: Sequelize.STRING(3), allowNull: false },           // the photographer's selling currency
            status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'ready' },
            external_id: { type: Sequelize.STRING(100), allowNull: false },      // SmatPay merchant id / Paystack subaccount code
            credentials_enc: { type: Sequelize.TEXT, allowNull: true },          // encrypted, provider-specific (SmatPay keys)
            approved: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            display_name: { type: Sequelize.STRING(150), allowNull: false },     // business / trading name
            details: { type: Sequelize.TEXT, allowNull: true },                  // JSON: non-secret form values + provider data
            created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        });

        const [merchants] = await queryInterface.sequelize.query('SELECT * FROM merchants');
        for (const m of merchants) {
            const details = {
                smatpay_account_id: m.smatpay_account_id, product_code: m.product_code,
                title: m.title, gender: m.gender, date_of_birth: m.date_of_birth, phone: m.phone,
                trading_name: m.trading_name, business_description: m.business_description,
                trading_address: m.trading_address, province: m.province, country: m.country,
            };
            await queryInterface.bulkInsert('payout_accounts', [{
                user_id: m.user_id, provider: 'smatpay', country: 'ZW', currency: 'USD', status: m.status,
                external_id: m.merchant_id, credentials_enc: m.keys_enc, approved: m.approved,
                display_name: m.trading_name, details: JSON.stringify(details),
                created_at: m.created_at, updated_at: m.updated_at,
            }]);
        }
        await queryInterface.dropTable('merchants');

        // Which gateway took each payment (all existing orders went through SmatPay).
        await queryInterface.addColumn('orders', 'provider', { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'smatpay' });
    },
    down: async () => {
        throw new Error('Irreversible: payout_accounts replaced merchants');
    },
};
