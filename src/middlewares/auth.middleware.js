const supabase = require('../config/supabaseClient');

const authMiddleware = async (req, res, next) => {
  try {
    // Expect: Authorization: Bearer <token>
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header missing'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token missing'
      });
    }

    // Verify user using Supabase
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        success: false,
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
      return res.status(403).json({
        success: false,
        message: 'User profile not found'
      });
    }

    if (profile.status !== 'APPROVED') {
      return res.status(403).json({
        success: false,
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
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

module.exports = authMiddleware;
