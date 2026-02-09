const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const reviewController = require('../controllers/review.controller');

const router = express.Router();

/**
 * Get pending purchase proofs (Admin)
 */
router.get(
  '/purchase-proofs/pending',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.getPendingPurchaseProofs
);

/**
 * Approve purchase proof (Admin)
 */
router.patch(
  '/purchase-proofs/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.approvePurchaseProof
);

/**
 * Reject purchase proof (Admin)
 */
router.patch(
  '/purchase-proofs/:id/reject',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.rejectPurchaseProof
);

module.exports = router;
