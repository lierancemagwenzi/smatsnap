// Restricts a route to one or more user types, e.g. userType('creator').
// Must run after authentication.authenticateToken.
module.exports = (...allowed) => (req, res, next) => {
    if (!req.dbUser || !allowed.includes(req.dbUser.user_type)) {
        return res.status(403).json({ message: 'Forbidden for this account type' });
    }
    next();
};
