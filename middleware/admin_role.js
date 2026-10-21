// Restricts an admin route to admin roles, e.g. adminRole('super_admin').
// Must run after authentication.authenticateToken and userType('admin').
module.exports = (...allowed) => (req, res, next) => {
    if (!req.dbUser || !allowed.includes(req.dbUser.admin_role)) {
        return res.status(403).json({ message: 'Only super admins can do this' });
    }
    next();
};
