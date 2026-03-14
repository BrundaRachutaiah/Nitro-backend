const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const reviewController = require('../controllers/review.controller');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────────
// PURCHASE PROOF (INVOICE) ROUTES
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Get purchase proofs with optional status filter (Admin)
 */
router.get(
  '/purchase-proofs',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.getPurchaseProofs
);

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

// ────────────────────────────────────────────────────────────────────────────────
// PARTICIPANT REVIEW ROUTES
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Get participant reviews with optional status filter (Admin)
 */
router.get(
  '/participant-reviews',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.getParticipantReviews
);

/**
 * Get pending participant reviews (Admin)
 */
router.get(
  '/participant-reviews/pending',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.getPendingParticipantReviews
);

/**
 * Approve participant review (Admin)
 */
router.patch(
  '/participant-reviews/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.approveParticipantReview
);

/**
 * Reject participant review (Admin)
 */
router.patch(
  '/participant-reviews/:id/reject',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  reviewController.rejectParticipantReview
);

module.exports = router;