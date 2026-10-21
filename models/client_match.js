'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class client_match extends Model {
        static associate(models) {
            client_match.belongsTo(models.media, { foreignKey: 'media_id', as: 'media' });
        }
    }

    client_match.init({
        client_id: DataTypes.INTEGER,
        event_id: DataTypes.INTEGER,
        media_id: DataTypes.INTEGER,
        similarity: DataTypes.FLOAT,
        hidden: DataTypes.BOOLEAN,
        times: {
            type: DataTypes.TEXT,
            get() {
                const raw = this.getDataValue('times');
                return raw ? JSON.parse(raw) : [];
            },
            set(value) {
                this.setDataValue('times', value && value.length ? JSON.stringify(value) : null);
            },
        },
    }, {
        sequelize,
        modelName: 'client_match',
        underscored: true,
    });

    return client_match;
};
