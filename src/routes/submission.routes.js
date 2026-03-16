const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const submissionController = require('../controllers/submission.controller');

const router = express.Router();

router.post(
  '/feedback',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'ADMIN', 'SUPER_ADMIN'),
  submissionController.submitFeedback
);

router.post(
  '/review',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'ADMIN', 'SUPER_ADMIN'),
  submissionController.submitReview
);

router.get(
  '/admin/reviews/pending',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  submissionController.getPendingReviews
);

router.get(
  '/admin/reviews',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  submissionController.getReviews
);

router.patch(
  '/admin/reviews/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  submissionController.approveReview
);

router.patch(
  '/admin/reviews/:id/reject',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  submissionController.rejectReview
);

module.exports = router;