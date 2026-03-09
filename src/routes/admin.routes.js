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

router.delete(
  '/participants/:id',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  adminController.deleteParticipant
);

router.patch(
  '/participants/:id/promote-admin',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  adminController.promoteParticipantToAdmin
);

router.patch(
  '/admins/:id/remove-access',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  adminController.removeAdminAccess
);

router.get(
  '/participants',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getAllParticipants
);

router.get(
  '/admins',
  authMiddleware,
  roleMiddleware('SUPER_ADMIN'),
  adminController.getAllAdmins
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
  '/applications/summary',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getApplicationSummary
);

router.get(
  '/project-access/pending',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getPendingProjectAccessRequests
);

router.patch(
  '/project-access/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.approveProjectAccessRequest
);

router.patch(
  '/project-access/:id/reject',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.rejectProjectAccessRequest
);

router.get(
  '/applications/pending',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getPendingProductApplications
);

router.patch(
  '/applications/:id/approve',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.approveProductApplication
);

router.patch(
  '/applications/:id/reject',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.rejectProductApplication
);

router.post(
  '/applications/bulk-decide',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.bulkDecideApplications
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
  '/payouts/eligible',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getEligiblePayouts
);

router.get(
  '/reports/payouts',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getPayoutReport
);

router.get(
  '/reports/payouts/export',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.exportPayoutReportCSV
);

router.get(
  '/payout-batches',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.getPayoutBatches
);

router.patch(
  '/payout-batches/:id/mark-paid',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.markPayoutBatchPaid
);

router.get(
  '/payout-batches/export',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.exportPayoutBatchesCSV
);

router.get(
  '/payout-batches/:id/export',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.exportPayoutBatchCSV
);

router.get(
  '/payouts/:payoutId/export',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.exportPayoutCSV
);

router.patch(
  '/payouts/:payoutId/mark-paid',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.markPayoutPaid
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

// DEBUG: Payout eligibility trace
router.get(
  '/debug/payouts',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  adminController.debugPayouts
);

module.exports = router;
