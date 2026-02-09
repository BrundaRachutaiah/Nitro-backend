const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
const { globalSearch } = require('../controllers/search.controller');

router.get(
  '/',
  authMiddleware,
  globalSearch
);

module.exports = router;
