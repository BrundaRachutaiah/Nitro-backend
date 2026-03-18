const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const authAnyStatusMiddleware = require('../middlewares/authAnyStatus.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const applicationController = require('../controllers/application.controller');

const router = express.Router();

// Apply to project
router.post(
  '/projects/:projectId/apply',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'ADMIN', 'SUPER_ADMIN'),
  applicationController.applyToProject
);

// Get my applications
router.get(
  '/applications/my',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'ADMIN', 'SUPER_ADMIN'),
  applicationController.getMyApplications
);

router.patch(
  '/applications/:id/purchased',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  applicationController.markApplicationPurchased
);

router.get(
  '/applications/payment-details',
  authAnyStatusMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  applicationController.getPaymentDetails
);

router.put(
  '/applications/payment-details',
  authAnyStatusMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  applicationController.savePaymentDetails
);

module.exports = router;