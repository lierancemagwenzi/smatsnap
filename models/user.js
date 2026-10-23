'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
    class user extends Model {
        static associate(models) {
            user.hasOne(models.payout_account, { foreignKey: 'user_id', as: 'payout' });
        }

        /** Where purchase notices go: the login email, or the email a guest gave at checkout. */
        get noticeEmail() {
            return this.email || this.contact_email || null;
        }

        // Shape returned to clients — never includes password/otp/refresh token hashes.
        toPublicJSON() {
            return {
                id: this.id,
                name: this.name,
                lastname: this.lastname,
                email: this.email,
                user_type: this.user_type,
                status: this.status,
                email_verified_at: this.email_verified_at,
                ...(this.is_guest ? { is_guest: true, contact_email: this.contact_email } : {}),
                ...(this.user_type === 'admin' ? { admin_role: this.admin_role } : {}),
            };
        }
    }

    user.init({
        name: DataTypes.STRING,
        lastname: DataTypes.STRING,
        email: DataTypes.STRING,
        // Guests only: where purchase emails go (never a login).
        contact_email: DataTypes.STRING,
        // 'creator' (photographer) | 'client' | 'admin' (dashboard only, never via signup)
        user_type: DataTypes.STRING,
        // Guest client (no account): no email/password, signed in by its own refresh token only.
        is_guest: DataTypes.BOOLEAN,
        // Admins only: 'super_admin' (also manages admins) | 'admin'
        admin_role: DataTypes.STRING,
        status: DataTypes.STRING,
        password: DataTypes.STRING,
        email_verified_at: DataTypes.DATE,
        // OTPs are stored hashed, single-purpose and time-boxed (see helpers/otp.js).
        otp_hash: DataTypes.STRING,
        otp_purpose: DataTypes.STRING,
        otp_expires_at: DataTypes.DATE,
        otp_attempts: DataTypes.INTEGER,
        otp_sent_at: DataTypes.DATE,
        // Hash of the currently valid refresh token; rotated on every refresh, cleared on logout.
        refresh_token_hash: DataTypes.STRING,
        last_login_at: DataTypes.DATE,
        face_consent_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'user',
        underscored: true,
    });

    return user;
};
