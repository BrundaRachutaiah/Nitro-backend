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

const app = express();

// Global middlewares
app.use(cors());
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

// Root
app.get('/', (req, res) => {
  res.json({ status: 'Nitro backend running' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

// Start server
app.listen(env.port, () => {
  console.log(`Server running on port ${env.port}`);
});
