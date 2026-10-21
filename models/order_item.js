'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class order_item extends Model {
        static associate(models) {
            order_item.belongsTo(models.order, { foreignKey: 'order_id', as: 'order' });
            order_item.belongsTo(models.media, { foreignKey: 'media_id', as: 'media' });
        }
    }

    order_item.init({
        order_id: DataTypes.INTEGER,
        media_id: DataTypes.INTEGER,
        price: DataTypes.DECIMAL(10, 2),
    }, { sequelize, modelName: 'order_item', underscored: true });

    return order_item;
};
