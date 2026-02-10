const { sendError } = require('../utils/response.utils');
const { HTTP_STATUS } = require('../utils/constants');

const roleMiddleware = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: 'User not authenticated'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return sendError(res, {
        status: HTTP_STATUS.FORBIDDEN,
        message: 'Access denied'
      });
    }

    next();
  };
};

module.exports = roleMiddleware;
