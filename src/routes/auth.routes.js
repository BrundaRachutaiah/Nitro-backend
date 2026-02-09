const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const authController = require('../controllers/auth.controller');

const router = express.Router();

/**
 * Verify token + get current user
 * Used by frontend to confirm login state
 */
router.get(
  '/me',
  authMiddleware,
  authController.verifyAuth
);

module.exports = router;
