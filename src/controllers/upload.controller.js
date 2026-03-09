const supabase = require('../config/supabaseClient');
const path = require('path');
const { ALLOCATION_STATUS } = require('../utils/constants');

const isMissingSchemaObjectError = (error) => {
  const text = String(error?.message || '').toLowerCase();
  return (
    text.includes('does not exist')
    || text.includes('could not find')
    || text.includes('schema cache')
    || text.includes('column')
    || text.includes('relation')
    || text.includes('table')
  );
};

const productBelongsToParticipantAllocation = async ({ participantId, productId }) => {
  // FIX: ONE allocation covers products from ALL brands/projects.
  // Do NOT filter by project_id — a Veda & Co product belongs to the same
  // participant allocation even though its project_id differs from the allocation's project_id.
  if (!productId) return false;
  const { data, error } = await supabase
    .from('project_applications')
    .select('id')
    .eq('participant_id', participantId)
    .eq('product_id', productId)
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
};

/**
 * Upload purchase proof
 */
const uploadPurchaseProof = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId, productId } = req.body;

    if (!req.file || !allocationId) {
      return res.status(400).json({
        success: false,
        message: 'Allocation ID and file are required'
      });
    }

    const { data: allocation, error: allocError } = await supabase
      .from('unit_allocations')
      .select('id, project_id, status')
      .eq('id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (allocError || !allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const activeStatuses = [ALLOCATION_STATUS.RESERVED, ALLOCATION_STATUS.PURCHASED];
    if (!activeStatuses.includes(allocation.status)) {
      return res.status(400).json({
        success: false,
        message: 'Allocation is not active'
      });
    }

    if (productId) {
      const belongs = await productBelongsToParticipantAllocation({
        participantId,
        productId
      });
      if (!belongs) {
        return res.status(400).json({
          success: false,
          message: 'Selected product is not part of this allocation'
        });
      }
    }

    // Check if a proof already exists for this specific product (or for the allocation if no productId)
    let existingQuery = supabase
      .from('purchase_proofs')
      .select('id')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId);

    if (productId) {
      existingQuery = existingQuery.eq('product_id', productId);
    } else {
      existingQuery = existingQuery.is('product_id', null);
    }

    let existingLookup = await existingQuery.maybeSingle();

    if (existingLookup.error && isMissingSchemaObjectError(existingLookup.error)) {
      if (productId) {
        // Schema doesn't have product_id column yet — cannot safely check per-product.
        // Skip the duplicate check to avoid incorrectly blocking other products in the
        // same allocation. Each product will get its own row once the schema is updated.
        existingLookup = { data: null, error: null };
      } else {
        // No productId provided — safe to fall back to allocation-level check
        existingLookup = await supabase
          .from('purchase_proofs')
          .select('id')
          .eq('allocation_id', allocationId)
          .eq('participant_id', participantId)
          .maybeSingle();
      }
    }

    if (existingLookup.error && !isMissingSchemaObjectError(existingLookup.error)) {
      throw existingLookup.error;
    }

    if (existingLookup.data) {
      return res.status(400).json({
        success: false,
        message: 'Purchase proof already uploaded for this product'
      });
    }

    const fileExt = path.extname(req.file.originalname);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fileName = `invoice_${uniqueSuffix}${fileExt}`;
    const filePath = `${participantId}/${allocationId}/${productId || 'set'}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from('purchase-proofs')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype
      });

    if (uploadError) throw uploadError;

    const { data: publicUrl } = supabase.storage
      .from('purchase-proofs')
      .getPublicUrl(filePath);

    let insertRes = await supabase
      .from('purchase_proofs')
      .insert({
        allocation_id: allocationId,
        participant_id: participantId,
        product_id: productId || null,
        file_url: publicUrl.publicUrl,
        status: 'PENDING'
      })
      .select()
      .maybeSingle();

    if (insertRes.error && isMissingSchemaObjectError(insertRes.error)) {
      // product_id column missing — insert without it, then fetch back the new row
      const fallbackInsert = await supabase
        .from('purchase_proofs')
        .insert({
          allocation_id: allocationId,
          participant_id: participantId,
          file_url: publicUrl.publicUrl,
          status: 'PENDING'
        });

      if (fallbackInsert.error && !isMissingSchemaObjectError(fallbackInsert.error)) {
        insertRes = { data: null, error: fallbackInsert.error };
      } else {
        // Fetch back any proof for this allocation (no created_at column exists)
        const fetchBack = await supabase
          .from('purchase_proofs')
          .select()
          .eq('allocation_id', allocationId)
          .eq('participant_id', participantId)
          .limit(1)
          .maybeSingle();
        insertRes = fetchBack;
      }
    }

    if (insertRes.error) throw insertRes.error;

    const data = insertRes.data;

    res.status(201).json({
      success: true,
      message: 'Purchase proof uploaded successfully',
      data: {
        ...data,
        product_id: data?.product_id || productId || null
      }
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
    const { allocationId, productId } = req.body;

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
    const filePath = `reviews/${participantId}/${allocationId}/${productId || 'set'}/${fileName}`;

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
        product_id: productId || null,
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
    const { allocationId, productId } = req.body;

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
      const filePath = `reviews/${participantId}/${allocationId}/${productId || 'set'}/${fileName}`;

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
        product_id: productId || null,
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