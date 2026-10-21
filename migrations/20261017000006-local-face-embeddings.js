'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        // Which helpers/faces provider produced the row — embeddings/ids aren't
        // interchangeable, so searches only look at the current provider's rows.
        await queryInterface.addColumn('media_faces', 'provider', { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'local' });
        // local provider: L2-normalised float32 x128 (512 bytes). Rekognition: null (faces live in AWS).
        await queryInterface.addColumn('media_faces', 'embedding', { type: Sequelize.BLOB, allowNull: true });
        // Seconds into a video where this face was seen (null for photos).
        await queryInterface.addColumn('media_faces', 'frame_time', { type: Sequelize.FLOAT, allowNull: true });
        await queryInterface.changeColumn('media_faces', 'face_id', { type: Sequelize.STRING(64), allowNull: true });
        await queryInterface.addIndex('media_faces', ['event_id', 'provider']);

        await queryInterface.addColumn('media', 'duration_seconds', { type: Sequelize.FLOAT, allowNull: true });
        // JSON array of seconds where the client appears in a matched video.
        await queryInterface.addColumn('client_matches', 'times', { type: Sequelize.TEXT, allowNull: true });
        // Explicit consent to process a selfie for face matching (biometric data).
        await queryInterface.addColumn('users', 'face_consent_at', { type: Sequelize.DATE, allowNull: true });
    },
    down: async (queryInterface, Sequelize) => {
        await queryInterface.removeColumn('users', 'face_consent_at');
        await queryInterface.removeColumn('client_matches', 'times');
        await queryInterface.removeColumn('media', 'duration_seconds');
        await queryInterface.removeIndex('media_faces', ['event_id', 'provider']);
        await queryInterface.changeColumn('media_faces', 'face_id', { type: Sequelize.STRING(64), allowNull: false });
        await queryInterface.removeColumn('media_faces', 'frame_time');
        await queryInterface.removeColumn('media_faces', 'embedding');
        await queryInterface.removeColumn('media_faces', 'provider');
    }
};
