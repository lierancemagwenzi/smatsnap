'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class media_face extends Model {
        static associate(models) {
            media_face.belongsTo(models.media, { foreignKey: 'media_id', as: 'media' });
        }
    }

    media_face.init({
        media_id: DataTypes.INTEGER,
        event_id: DataTypes.INTEGER,
        face_id: DataTypes.STRING,
        provider: DataTypes.STRING,
        embedding: DataTypes.BLOB,
        frame_time: DataTypes.FLOAT,
    }, {
        sequelize,
        modelName: 'media_face',
        underscored: true,
    });

    return media_face;
};
