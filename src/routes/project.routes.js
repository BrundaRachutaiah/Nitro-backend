const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const projectController = require('../controllers/project.controller');

const router = express.Router();

// Create project (Admin)
router.post(
  '/',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  projectController.createProject
);

// Get all projects
router.get(
  '/',
  authMiddleware,
  projectController.getAllProjects
);

// Get project by ID
router.get(
  '/:id',
  authMiddleware,
  projectController.getProjectById
);

// Update project (Admin)
router.patch(
  '/:id',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  projectController.updateProject
);

// Participant project lists
router.get(
  '/applied',
  authMiddleware,
  projectController.getAppliedProjects
);

router.get(
  '/active',
  authMiddleware,
  projectController.getActiveProjects
);

router.get(
  '/completed',
  authMiddleware,
  projectController.getCompletedProjects
);

router.get(
  '/available',
  authMiddleware,
  projectController.getAvailableProjects
);

router.get(
  '/:id/summary',
  authMiddleware,
  projectController.getProjectSummary
);

// Admin project controls
router.get(
  '/admin',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  projectController.getAdminProjects
);

router.patch(
  '/:id/status',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  projectController.updateProjectStatus
);

router.get(
  '/:id/stats',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  projectController.getProjectStats
);

module.exports = router;
