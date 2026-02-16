const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const brandController = require('../controllers/brand.controller');

const router = express.Router();

router.get(
  '/projects',
  authMiddleware,
  roleMiddleware('BRAND', 'ADMIN', 'SUPER_ADMIN'),
  brandController.getBrandProjects
);

router.get(
  '/analytics',
  authMiddleware,
  roleMiddleware('BRAND', 'ADMIN', 'SUPER_ADMIN'),
  brandController.getBrandAnalytics
);

module.exports = router;
