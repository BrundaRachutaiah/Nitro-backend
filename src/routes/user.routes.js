const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const userController = require('../controllers/user.controller');

const router = express.Router();

router.get('/me', authMiddleware, userController.getMyProfile);
router.patch('/me', authMiddleware, userController.updateMyProfile);

router.get(
  '/me/notifications',
  authMiddleware,
  userController.getMyNotificationSettings
);

router.patch(
  '/me/notifications',
  authMiddleware,
  userController.updateMyNotificationSettings
);

router.get(
  '/purchase-proofs/my',
  authMiddleware,
  userController.getMyPurchaseProofs
);

router.get(
  '/me/profile-completion',
  authMiddleware,
  userController.getProfileCompletion
);

router.get(
  '/notifications/my',
  authMiddleware,
  userController.getMyNotifications
);

router.patch(
  '/notifications/:id/read',
  authMiddleware,
  userController.markNotificationRead
);

router.post(
  '/support/tickets',
  authMiddleware,
  userController.createSupportTicket
);

router.get(
  '/support/tickets/my',
  authMiddleware,
  userController.getMySupportTickets
);

module.exports = router;
