'use strict';
const { Model } = require('sequelize');

// Audit log of admin changes (see handlers/AdminHandler.js).
module.exports = (sequelize, DataTypes) => {
    class admin_action extends Model {
        static associate(models) {
            admin_action.belongsTo(models.user, { foreignKey: 'admin_id', as: 'admin' });
        }
    }

    admin_action.init({
        admin_id: DataTypes.INTEGER,
        action: DataTypes.STRING,
        target_type: DataTypes.STRING,
        target_id: DataTypes.INTEGER,
        details: {
            type: DataTypes.TEXT,
            get() {
                const raw = this.getDataValue('details');
                try { return raw ? JSON.parse(raw) : null; } catch { return null; }
            },
            set(value) {
                this.setDataValue('details', value ? JSON.stringify(value) : null);
            },
        },
    }, { sequelize, modelName: 'admin_action', underscored: true });

    return admin_action;
};
