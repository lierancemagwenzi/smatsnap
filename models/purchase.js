'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class purchase extends Model {
        static associate(models) {
            purchase.belongsTo(models.media, { foreignKey: 'media_id', as: 'media' });
            purchase.belongsTo(models.order, { foreignKey: 'order_id', as: 'order' });
        }
    }

    purchase.init({
        client_id: DataTypes.INTEGER,
        media_id: DataTypes.INTEGER,
        order_id: DataTypes.INTEGER,
        download_until: DataTypes.DATE,
    }, { sequelize, modelName: 'purchase', underscored: true });

    return purchase;
};
