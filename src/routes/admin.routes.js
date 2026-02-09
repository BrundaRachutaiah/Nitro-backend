const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const adminController = require('../controllers/admin.controller');

const router = express.Router();

// Participants
router.get(
  '/participants/pending',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getPendingParticipants
);

router.patch(
  '/participants/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.approveParticipant
);

router.patch(
  '/participants/:id/reject',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.rejectParticipant
);

router.get(
  '/participants',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getAllParticipants
);

router.get(
  '/participants/:id',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getParticipantById
);

// Dashboard + activity
router.get(
  '/dashboard/summary',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getAdminDashboardSummary
);

router.get(
  '/activity',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getAdminActivity
);

// Approvals + search
router.get(
  '/approvals/count',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getApprovalsCount
);

router.get(
  '/approvals',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getApprovals
);

router.get(
  '/search',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.adminSearch
);

// Purchase proofs + payouts
router.patch(
  '/purchase-proofs/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.approvePurchaseProof
);

router.post(
  '/payout-batches',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.generatePayoutBatch
);

router.get(
  '/payout-batches/:id/export',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.exportPayoutBatchCSV
);

// Support tickets
router.get(
  '/support/tickets',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getAdminSupportTickets
);

router.get(
  '/support/tickets/:id',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getAdminSupportTicketById
);

router.patch(
  '/support/tickets/:id/status',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.updateSupportTicketStatus
);

// Analytics
router.get(
  '/analytics/funnel',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getFunnelAnalytics
);

router.get(
  '/analytics/payouts',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getPayoutAnalytics
);

router.get(
  '/analytics/support',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getSupportAnalytics
);

module.exports = router;
