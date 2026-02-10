const { sendError } = require('../utils/response.utils');
const { HTTP_STATUS } = require('../utils/constants');

const errorMiddleware = (err, req, res, next) => {
  console.error(err.stack);

  sendError(res, {
    status: err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR,
    message: err.message || 'Internal Server Error'
  });
};

module.exports = errorMiddleware;
