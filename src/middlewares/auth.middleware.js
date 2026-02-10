const supabase = require('../config/supabaseClient');
const { sendError } = require('../utils/response.utils');
const { HTTP_STATUS, PROFILE_STATUS } = require('../utils/constants');

const authMiddleware = async (req, res, next) => {
  try {
    // Expect: Authorization: Bearer <token>
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

    // Verify user using Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return sendError(res, {
        status: HTTP_STATUS.UNAUTHORIZED,
        message: 'Invalid or expired token'
      });
    }

    const userId = data.user.id;

    // Fetch profile
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

    if (profile.status !== PROFILE_STATUS.APPROVED) {
      return sendError(res, {
        status: HTTP_STATUS.FORBIDDEN,
        message: 'User not approved'
      });
    }

    // Attach user to request
    req.user = {
      id: profile.id,
      role: profile.role,
      status: profile.status
    };

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    sendError(res, {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      message: 'Authentication failed'
    });
  }
};

module.exports = authMiddleware;
