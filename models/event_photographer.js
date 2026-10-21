'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class event_photographer extends Model {
        static associate(models) {
            event_photographer.belongsTo(models.event, { foreignKey: 'event_id', as: 'event' });
            event_photographer.belongsTo(models.user, { foreignKey: 'creator_id', as: 'creator' });
        }
    }

    event_photographer.init({
        event_id: DataTypes.INTEGER,
        creator_id: DataTypes.INTEGER,
        price: DataTypes.DECIMAL(10, 2),
        currency: DataTypes.STRING,
    }, {
        sequelize,
        modelName: 'event_photographer',
        underscored: true,
    });

    return event_photographer;
};
