const express = require('express');
const auth = require('../middlewares/auth.middleware');
const role = require('../middlewares/role.middleware');
const controller = require('../controllers/activity.controller');

const router = express.Router();

router.get('/my', auth, controller.getMyActivity);
router.get('/admin', auth, role('ADMIN', 'SUPER_ADMIN'), controller.getAdminActivity);

module.exports = router;
