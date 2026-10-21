'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class order extends Model {
        static associate(models) {
            order.hasMany(models.order_item, { foreignKey: 'order_id', as: 'items' });
            order.belongsTo(models.user, { foreignKey: 'creator_id', as: 'creator' });
            order.belongsTo(models.user, { foreignKey: 'client_id', as: 'client' });
            order.belongsTo(models.event, { foreignKey: 'event_id', as: 'event' });
        }

        toPublicJSON() {
            return {
                id: this.id,
                reference: this.reference,
                status: this.status,
                wallet: this.wallet,
                currency: this.currency,
                subtotal: Number(this.subtotal),
                fee: Number(this.fee),
                total: Number(this.total),
                payment_code: this.payment_code,
                redirect_url: this.status === 'PENDING' ? this.redirect_url : null,
                paid_at: this.paid_at,
                created_at: this.created_at,
                item_count: this.items ? this.items.length : undefined,
            };
        }
    }

    order.init({
        reference: DataTypes.STRING,
        client_id: DataTypes.INTEGER,
        creator_id: DataTypes.INTEGER,
        event_id: DataTypes.INTEGER,
        provider: DataTypes.STRING,
        wallet: DataTypes.STRING,
        payer_mobile: DataTypes.STRING,
        currency: DataTypes.STRING,
        subtotal: DataTypes.DECIMAL(10, 2),
        fee: DataTypes.DECIMAL(10, 2),
        total: DataTypes.DECIMAL(10, 2),
        status: DataTypes.STRING,
        provider_status: DataTypes.STRING,
        payment_code: DataTypes.STRING,
        redirect_url: DataTypes.TEXT,
        paid_at: DataTypes.DATE,
        last_checked_at: DataTypes.DATE,
    }, { sequelize, modelName: 'order', underscored: true });

    return order;
};
