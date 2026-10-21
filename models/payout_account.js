'use strict';
const { Model } = require('sequelize');
const cryptoHelper = require('../helpers/cryptoHelper');

// A photographer's account with the payment gateway of their country (helpers/payments).
module.exports = (sequelize, DataTypes) => {
    class payout_account extends Model {
        static associate(models) {
            payout_account.belongsTo(models.user, { foreignKey: 'user_id', as: 'user' });
        }

        get isReady() {
            return this.status === 'ready';
        }

        /** Provider-specific secrets (e.g. SmatPay keys) — decrypted on demand, never sent out. */
        credentials() {
            return this.credentials_enc ? JSON.parse(cryptoHelper.decrypt(this.credentials_enc)) : null;
        }

        detailsJSON() {
            try { return this.details ? JSON.parse(this.details) : {}; } catch { return {}; }
        }

        toPublicJSON() {
            return {
                provider: this.provider,
                country: this.country,
                currency: this.currency,
                status: this.status,
                approved: this.approved,
                account_id: this.external_id,
                display_name: this.display_name,
            };
        }
    }

    payout_account.init({
        user_id: DataTypes.INTEGER,
        provider: DataTypes.STRING,
        country: DataTypes.STRING,
        currency: DataTypes.STRING,
        status: DataTypes.STRING,
        external_id: DataTypes.STRING,
        credentials_enc: DataTypes.TEXT,
        approved: DataTypes.BOOLEAN,
        display_name: DataTypes.STRING,
        details: DataTypes.TEXT,
    }, { sequelize, modelName: 'payout_account', underscored: true });

    return payout_account;
};
