const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const payoutController = require('../controllers/payout.controller');

const router = express.Router();

// Create payout batch (Admin)
router.post(
  '/payouts/batch',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  payoutController.createPayoutBatch
);

// Get payout batches (Admin)
router.get(
  '/payouts',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  payoutController.getPayoutBatches
);

// Get my payouts (Participant)
router.get(
  '/payouts/my',
  authMiddleware,
  payoutController.getMyPayouts
);

module.exports = router;
