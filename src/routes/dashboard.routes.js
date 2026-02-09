const express = require('express');
const auth = require('../middlewares/auth.middleware');
const role = require('../middlewares/role.middleware');
const controller = require('../controllers/dashboard.controller');

const router = express.Router();

router.get('/summary', auth, role('ADMIN', 'SUPER_ADMIN'), controller.getSummary);
router.get('/activity', auth, role('ADMIN', 'SUPER_ADMIN'), controller.getActivity);
router.get('/project-performance', auth, role('ADMIN', 'SUPER_ADMIN'), controller.getProjectPerformance);
router.get('/export', auth, role('ADMIN', 'SUPER_ADMIN'), controller.exportData);

module.exports = router;
