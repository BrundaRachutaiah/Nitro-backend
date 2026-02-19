const express = require('express');
const multer = require('multer');
const authMiddleware = require('../middlewares/auth.middleware');
const roleMiddleware = require('../middlewares/role.middleware');
const uploadController = require('../controllers/upload.controller');

const router = express.Router();

// Multer config (memory storage)
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Upload purchase proof
router.post(
  '/uploads/purchase-proof',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  upload.single('file'),
  uploadController.uploadPurchaseProof
);

router.post(
  '/uploads/review-proof',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  upload.single('file'),
  uploadController.uploadReviewProof
);

router.post(
  '/uploads/review-proofs',
  authMiddleware,
  roleMiddleware('PARTICIPANT'),
  upload.array('files', 6),
  uploadController.uploadReviewProofs
);

module.exports = router;
