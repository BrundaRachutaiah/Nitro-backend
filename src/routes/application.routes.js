const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const applicationController = require('../controllers/application.controller');

const router = express.Router();

// Apply to project
router.post(
  '/projects/:projectId/apply',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  applicationController.applyToProject
);

// Get my applications
router.get(
  '/applications/my',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  applicationController.getMyApplications
);

router.get(
  '/applications/payment-details',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  applicationController.getPaymentDetails
);

router.put(
  '/applications/payment-details',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  applicationController.savePaymentDetails
);

module.exports = router;
