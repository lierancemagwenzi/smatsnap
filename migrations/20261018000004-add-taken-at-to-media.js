'use strict';
module.exports = {
    up: async (queryInterface, Sequelize) => {
        // When the photo/video was captured, from its metadata — galleries file saved copies under
        // this date. Photos: EXIF local time "YYYY-MM-DDTHH:mm:ss"; videos: ISO UTC; '' = none.
        await queryInterface.addColumn('media', 'taken_at', { type: Sequelize.STRING(30), allowNull: true });
    },
    down: async (queryInterface) => {
        await queryInterface.removeColumn('media', 'taken_at');
    }
};
