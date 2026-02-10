const { HTTP_STATUS } = require('./constants');

const sendSuccess = (res, { status = HTTP_STATUS.OK, message, data, meta } = {}) => {
  const payload = { success: true };

  if (message) payload.message = message;
  if (data !== undefined) payload.data = data;
  if (meta) payload.meta = meta;

  return res.status(status).json(payload);
};

const sendError = (
  res,
  { status = HTTP_STATUS.INTERNAL_SERVER_ERROR, message = 'Internal Server Error', errors } = {}
) => {
  const payload = { success: false, message };

  if (errors) payload.errors = errors;

  return res.status(status).json(payload);
};

module.exports = {
  sendSuccess,
  sendError
};
