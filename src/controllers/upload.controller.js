const supabase = require('../config/supabaseClient');
const path = require('path');
const { ALLOCATION_STATUS } = require('../utils/constants');

/**
 * Upload purchase proof
 */
const uploadPurchaseProof = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId } = req.body;

    if (!req.file || !allocationId) {
      return res.status(400).json({
        success: false,
        message: 'Allocation ID and file are required'
      });
    }

    const { data: allocation, error: allocError } = await supabase
      .from('unit_allocations')
      .select('id, status')
      .eq('id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (allocError || !allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    if (allocation.status !== ALLOCATION_STATUS.RESERVED) {
      return res.status(400).json({
        success: false,
        message: 'Allocation is not active'
      });
    }

    const { data: existing } = await supabase
      .from('purchase_proofs')
      .select('id')
      .eq('allocation_id', allocationId)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Purchase proof already uploaded'
      });
    }

    const fileExt = path.extname(req.file.originalname);
    const fileName = `invoice${fileExt}`;
    const filePath = `${participantId}/${allocationId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('purchase-proofs')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype
      });

    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase.storage
      .from('purchase-proofs')
      .getPublicUrl(filePath);

    const { data, error } = await supabase
      .from('purchase_proofs')
      .insert({
  allocation_id: allocationId,
  participant_id: participantId,
  file_url: publicUrl.publicUrl,
  status: 'PENDING'
})
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      success: true,
      message: 'Purchase proof uploaded successfully',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Upload review proof screenshot
 */
const uploadReviewProof = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId } = req.body;

    if (!req.file || !allocationId) {
      return res.status(400).json({
        success: false,
        message: 'Allocation ID and file are required'
      });
    }

    const { data: allocation, error: allocError } = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (allocError || !allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const fileExt = path.extname(req.file.originalname);
    const fileName = `review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${fileExt}`;
    const filePath = `reviews/${participantId}/${allocationId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('purchase-proofs')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype
      });

    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase.storage
      .from('purchase-proofs')
      .getPublicUrl(filePath);

    res.status(201).json({
      success: true,
      message: 'Review screenshot uploaded successfully',
      data: {
        allocation_id: allocationId,
        review_url: publicUrl.publicUrl
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Upload multiple review screenshots
 */
const uploadReviewProofs = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId } = req.body;

    if (!Array.isArray(req.files) || req.files.length === 0 || !allocationId) {
      return res.status(400).json({
        success: false,
        message: 'Allocation ID and at least one file are required'
      });
    }

    const { data: allocation, error: allocError } = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (allocError || !allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const uploaded = [];
    for (const file of req.files) {
      const fileExt = path.extname(file.originalname);
      const fileName = `review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${fileExt}`;
      const filePath = `reviews/${participantId}/${allocationId}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('purchase-proofs')
        .upload(filePath, file.buffer, {
          contentType: file.mimetype
        });

      if (uploadError) throw uploadError;

      const { data: publicUrl } = supabase.storage
        .from('purchase-proofs')
        .getPublicUrl(filePath);

      uploaded.push(publicUrl.publicUrl);
    }

    res.status(201).json({
      success: true,
      message: 'Review screenshots uploaded successfully',
      data: {
        allocation_id: allocationId,
        review_urls: uploaded
      }
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  uploadPurchaseProof,
  uploadReviewProof,
  uploadReviewProofs
};
