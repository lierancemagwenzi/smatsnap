'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        // Set while a large file is being uploaded in parts (S3 multipart upload).
        await queryInterface.addColumn('media', 'upload_id', { type: Sequelize.STRING(255), allowNull: true });
        await queryInterface.addColumn('media', 'part_size', { type: Sequelize.INTEGER, allowNull: true });
    },
    down: async (queryInterface) => {
        await queryInterface.removeColumn('media', 'part_size');
        await queryInterface.removeColumn('media', 'upload_id');
    }
};
