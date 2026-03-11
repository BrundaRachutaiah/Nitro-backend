const supabase = require('../config/supabaseClient');
const { sendError } = require('../utils/response.utils');
const { HTTP_STATUS } = require('../utils/constants');

const authAnyStatusMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return sendError(res, {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: 'Authorization header missing'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return sendError(res, {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: 'Token missing'
      });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return sendError(res, {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: 'Invalid or expired token'
      });
    }

    const userId = data.user.id;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role, status')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      return sendError(res, {
        status: HTTP_STATUS.FORBIDDEN,
        message: 'User profile not found'
      });
    }

    req.user = {
      id: profile.id,
      role: profile.role,
      status: profile.status
    };

    next();
  } catch (err) {
    console.error('Auth(any status) middleware error:', err);
    sendError(res, {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      message: 'Authentication failed'
    });
  }
};

module.exports = authAnyStatusMiddleware;
