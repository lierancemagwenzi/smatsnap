'use strict';
// Guest clients: people who find and buy their photos without creating an account. A guest is a
// `client` row with no email/password; the email they give at checkout (for download links) is
// kept in contact_email so it can't collide with a real account's login email.
module.exports = {
    up: async (queryInterface, Sequelize) => {
        // MODIFY keeps the existing unique index on email (NULLs don't collide in MySQL).
        await queryInterface.changeColumn('users', 'email', { type: Sequelize.STRING(191), allowNull: true });
        await queryInterface.changeColumn('users', 'password', { type: Sequelize.STRING, allowNull: true });
        await queryInterface.addColumn('users', 'is_guest', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false, after: 'user_type' });
        await queryInterface.addColumn('users', 'contact_email', { type: Sequelize.STRING(191), allowNull: true, after: 'email' });
        await queryInterface.addIndex('users', ['is_guest']);
    },
    down: async (queryInterface, Sequelize) => {
        await queryInterface.sequelize.query('DELETE FROM users WHERE is_guest = 1');
        await queryInterface.removeIndex('users', ['is_guest']);
        await queryInterface.removeColumn('users', 'contact_email');
        await queryInterface.removeColumn('users', 'is_guest');
        await queryInterface.changeColumn('users', 'password', { type: Sequelize.STRING, allowNull: false });
        await queryInterface.changeColumn('users', 'email', { type: Sequelize.STRING(191), allowNull: false });
    },
};
