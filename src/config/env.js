const dotenv = require('dotenv');
dotenv.config();

const env = {
  port: process.env.PORT || 5000,

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },

  email: {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD
  }
};

if (!env.supabase.url || !env.supabase.serviceRoleKey) {
  throw new Error('Supabase environment variables missing');
}

const getJwtRole = (jwt) => {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.role || null;
  } catch {
    return null;
  }
};

const supabaseKeyRole = getJwtRole(env.supabase.serviceRoleKey);
if (supabaseKeyRole && supabaseKeyRole !== 'service_role') {
  throw new Error(
    `SUPABASE_SERVICE_ROLE_KEY is invalid for backend use (detected role: ${supabaseKeyRole}). ` +
      'Use the service_role key from Supabase Project Settings > API.'
  );
}

module.exports = env;
