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

module.exports = env;
