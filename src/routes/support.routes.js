const express = require('express');
const auth = require('../middlewares/auth.middleware');
const controller = require('../controllers/support.controller');

const router = express.Router();

router.post('/tickets', auth, controller.createTicket);
router.get('/tickets/my', auth, controller.getMyTickets);

module.exports = router;
