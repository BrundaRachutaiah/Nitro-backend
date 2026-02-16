const express = require('express');
const cors = require('cors');

const env = require('./config/env');

// Jobs
const startAllocationExpiryJob = require('./jobs/allocationExpiry.job');

// Routes
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const projectRoutes = require('./routes/project.routes');
const applicationRoutes = require('./routes/application.routes');
const allocationRoutes = require('./routes/allocation.routes');
const uploadRoutes = require('./routes/upload.routes');
const reviewRoutes = require('./routes/review.routes');
const payoutRoutes = require('./routes/payout.routes');
const userRoutes = require('./routes/user.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const activityRoutes = require('./routes/activity.routes');
const notificationRoutes = require('./routes/notification.routes');
const supportRoutes = require('./routes/support.routes');
const searchRoutes = require('./routes/search.routes');
const submissionRoutes = require('./routes/submission.routes');
const brandRoutes = require('./routes/brand.routes');
const { sendError } = require('./utils/response.utils');
const { HTTP_STATUS } = require('./utils/constants');

const app = express();

// Global middlewares
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://nitro.teamsuccesso.com',
  'https://nitro-stg.teamsuccesso.com'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

// Start background jobs
startAllocationExpiryJob();

// Routes
app.use('/health', healthRoutes);
app.use('/auth', authRoutes);

app.use('/admin', adminRoutes);
app.use('/admin', reviewRoutes);
app.use('/admin', payoutRoutes);
app.use('/admin/dashboard', dashboardRoutes);

app.use('/projects', projectRoutes);
app.use('/', applicationRoutes);
app.use('/', allocationRoutes);
app.use('/', uploadRoutes);
app.use('/users', userRoutes);
app.use('/activity', activityRoutes);
app.use('/notifications', notificationRoutes);
app.use('/support', supportRoutes);
app.use('/search', searchRoutes);
app.use('/', submissionRoutes);
app.use('/brand', brandRoutes);

// Root
app.get('/', (req, res) => {
  res.json({ status: 'Nitro backend running' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  sendError(res, {
    status: err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR,
    message: err.message || 'Internal Server Error'
  });
});

// Start server
app.listen(env.port, () => {
  console.log(`Server running on port ${env.port}`);
});
