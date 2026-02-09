const express = require('express');
const auth = require('../middlewares/auth.middleware');
const controller = require('../controllers/notification.controller');

const router = express.Router();

router.patch('/:id/read', auth, controller.markAsRead);

module.exports = router;
