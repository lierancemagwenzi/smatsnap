'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class event extends Model {
        static associate(models) {
            event.belongsTo(models.user, { foreignKey: 'created_by', as: 'creator' });
            event.hasMany(models.event_photographer, { foreignKey: 'event_id', as: 'photographers' });
            event.hasMany(models.media, { foreignKey: 'event_id', as: 'media' });
        }

        toPublicJSON() {
            return {
                id: this.id,
                name: this.name,
                venue: this.venue,
                city: this.city,
                start_date: this.start_date,
                end_date: this.end_date,
                code: this.code,
                status: this.status,
            };
        }
    }

    event.init({
        name: DataTypes.STRING,
        name_key: DataTypes.STRING,
        name_phonetic: DataTypes.STRING,
        name_acronym: DataTypes.STRING,
        venue: DataTypes.STRING,
        city: DataTypes.STRING,
        start_date: DataTypes.DATEONLY,
        end_date: DataTypes.DATEONLY,
        code: DataTypes.STRING,
        created_by: DataTypes.INTEGER,
        status: DataTypes.STRING,
    }, {
        sequelize,
        modelName: 'event',
        underscored: true,
    });

    return event;
};
