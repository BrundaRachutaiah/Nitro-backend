const express = require('express');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const projectController = require('../controllers/project.controller');
const supabase = require('../config/supabaseClient');

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
  '/catalog',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  projectController.getActiveCatalog
);

router.get(
  '/access-requests/my',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  projectController.getMyProjectAccessRequests
);

router.post(
  '/:id/request-access',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  projectController.requestProjectAccess
);

// Admin: get all products across all published projects (for admin-as-participant browse)
router.get(
  '/admin-products',
  authMiddleware,
  roleMiddleware('ADMIN', 'SUPER_ADMIN'),
  async (req, res, next) => {
    try {
      const { data: projects, error: projErr } = await supabase
        .from('projects')
        .select('id, title, category, status')
        .eq('status', 'published');
      if (projErr) throw projErr;

      const allProducts = [];
      await Promise.all((projects || []).map(async (proj) => {
        let { data: prods, error: prodErr } = await supabase
          .from('project_products')
          .select('id, name, product_url, image_url, product_value, is_active, created_at')
          .eq('project_id', proj.id)
          .order('created_at', { ascending: false });

        // Fallback if is_active column missing
        if (prodErr && /is_active/i.test(String(prodErr.message || ''))) {
          ({ data: prods } = await supabase
            .from('project_products')
            .select('id, name, product_url, image_url, product_value, created_at')
            .eq('project_id', proj.id)
            .order('created_at', { ascending: false }));
        }

        (prods || [])
          .filter((p) => p.is_active !== false)
          .forEach((p) => allProducts.push({
            ...p,
            project_id:       proj.id,
            project_title:    proj.title || 'Project',
            project_category: proj.category || 'General',
            selection_key:    proj.id + '::' + p.id,
          }));
      }));

      res.json({ success: true, data: allProducts });
    } catch (err) { next(err); }
  }
);

router.get(
  '/:id/products',
  authMiddleware,
  roleMiddleware('PARTICIPANT', 'SUPER_ADMIN'),
  projectController.getProjectProductsForParticipant
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