'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class media extends Model {
        static associate(models) {
            media.belongsTo(models.event, { foreignKey: 'event_id', as: 'event' });
            media.belongsTo(models.user, { foreignKey: 'creator_id', as: 'creator' });
            media.hasMany(models.media_face, { foreignKey: 'media_id', as: 'faces' });
        }
    }

    media.init({
        event_id: DataTypes.INTEGER,
        creator_id: DataTypes.INTEGER,
        type: DataTypes.STRING,
        original_key: DataTypes.STRING,
        thumb_key: DataTypes.STRING,
        preview_key: DataTypes.STRING,
        preview_thumb_key: DataTypes.STRING,
        face_status: DataTypes.STRING,
        face_count: DataTypes.INTEGER,
        filename: DataTypes.STRING,
        mime_type: DataTypes.STRING,
        size_bytes: DataTypes.BIGINT,
        width: DataTypes.INTEGER,
        height: DataTypes.INTEGER,
        duration_seconds: DataTypes.FLOAT,
        taken_at: DataTypes.STRING,
        price: DataTypes.DECIMAL(10, 2),
        status: DataTypes.STRING,
        // S3 multipart upload in progress (null for single-PUT uploads and once completed).
        upload_id: DataTypes.STRING,
        part_size: DataTypes.INTEGER,
        error: DataTypes.STRING,
        uploaded_at: DataTypes.DATE,
        expires_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'media',
        tableName: 'media',
        underscored: true,
    });

    return media;
};
