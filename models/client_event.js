'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class client_event extends Model {
        static associate(models) {
            client_event.belongsTo(models.event, { foreignKey: 'event_id', as: 'event' });
        }
    }

    client_event.init({
        client_id: DataTypes.INTEGER,
        event_id: DataTypes.INTEGER,
        last_searched_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'client_event',
        underscored: true,
    });

    return client_event;
};
