const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const allocationController = require('../controllers/allocation.controller');

const router = express.Router();

// Allocate unit (Admin)
router.post(
  '/applications/:applicationId/allocate',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  allocationController.allocateUnit
);

// Get my allocations (Participant)
router.get(
  '/allocations/my',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'ADMIN', 'SUPER_ADMIN'),
  allocationController.getMyAllocations
);

router.get(
  '/allocations/my/tracking',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'ADMIN', 'SUPER_ADMIN'),
  allocationController.getMyAllocationTracking
);

// Get active allocations
router.get(
  '/allocations/active',
  authMiddleware,
  allocationController.getActiveAllocations
);

// Get allocation by ID
router.get(
  '/allocations/:id',
  authMiddleware,
  allocationController.getAllocationById
);

// Update allocation status
router.patch(
  '/allocations/:id/status',
  authMiddleware,
  allocationController.updateAllocationStatus
);

// Cancel allocation (participant self-cancels a RESERVED or PURCHASED slot)
router.patch(
  '/allocations/:id/cancel',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  allocationController.cancelAllocation
);

module.exports = router;