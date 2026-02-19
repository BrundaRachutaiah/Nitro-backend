const supabase = require('../config/supabaseClient');
const { PROOF_STATUS } = require('../utils/constants');
const { sendEmail } = require('../services/email.service');
const {
  purchaseApprovedEmail,
  purchaseRejectedEmail
} = require('../services/email.templates');

const buildAppMapKey = (participantId, projectId) => `${participantId}::${projectId}`;

const getApprovedApplicationMap = async (participantIds, projectIds) => {
  if (!participantIds.length || !projectIds.length) {
    return new Map();
  }

  let appRows = [];
  let appRes = await supabase
    .from('project_applications')
    .select(
      `
      id,
      participant_id,
      project_id,
      product_id,
      status,
      project_products (
        id,
        name
      )
    `
    )
    .in('participant_id', participantIds)
    .in('project_id', projectIds)
    .eq('status', 'APPROVED')
    .order('created_at', { ascending: false });

  if (appRes.error && /created_at/i.test(String(appRes.error.message || ''))) {
    appRes = await supabase
      .from('project_applications')
      .select(
        `
        id,
        participant_id,
        project_id,
        product_id,
        status,
        project_products (
          id,
          name
        )
      `
      )
      .in('participant_id', participantIds)
      .in('project_id', projectIds)
      .eq('status', 'APPROVED');
  }

  if (appRes.error) throw appRes.error;
  appRows = appRes.data || [];

  const productIds = [...new Set(appRows.map((row) => row.product_id).filter(Boolean))];
  const missingProductLink = appRows.some((row) => row.product_id && !row.project_products);

  let productMap = new Map();
  if (missingProductLink && productIds.length) {
    const { data: products, error: productError } = await supabase
      .from('project_products')
      .select('id, name')
      .in('id', productIds);
    if (productError) throw productError;
    productMap = new Map((products || []).map((item) => [item.id, item]));
  }

  const approvedApplicationMap = new Map();
  for (const row of appRows) {
    const key = buildAppMapKey(row.participant_id, row.project_id);
    if (!approvedApplicationMap.has(key)) {
      approvedApplicationMap.set(key, {
        product_id: row.product_id || null,
        product_name: row?.project_products?.name || productMap.get(row.product_id)?.name || null
      });
    }
  }

  return approvedApplicationMap;
};

const enrichProofRows = async (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const allocationIds = [...new Set(rows.map((row) => row.allocation_id).filter(Boolean))];
  const participantIds = [...new Set(rows.map((row) => row.participant_id).filter(Boolean))];

  const { data: allocations, error: allocationError } = allocationIds.length
    ? await supabase
        .from('unit_allocations')
        .select('id, project_id')
        .in('id', allocationIds)
    : { data: [], error: null };
  if (allocationError) throw allocationError;

  const allocationMap = new Map((allocations || []).map((item) => [item.id, item.project_id]));
  const projectIds = [...new Set((allocations || []).map((row) => row.project_id).filter(Boolean))];

  const { data: projects, error: projectError } = projectIds.length
    ? await supabase
        .from('projects')
        .select('id, title, name')
        .in('id', projectIds)
    : { data: [], error: null };
  if (projectError) throw projectError;

  const projectMap = new Map(
    (projects || []).map((item) => [item.id, item.title || item.name || null])
  );
  const appMap = await getApprovedApplicationMap(participantIds, projectIds);

  return rows.map((row) => {
    const projectId = allocationMap.get(row.allocation_id) || null;
    const app = appMap.get(buildAppMapKey(row.participant_id, projectId)) || {};

    return {
      ...row,
      project_id: projectId,
      project_name: projectMap.get(projectId) || null,
      product_id: app.product_id || null,
      product_name: app.product_name || null
    };
  });
};

/**
 * Get all pending purchase proofs (Admin)
 */
const getPendingPurchaseProofs = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('purchase_proofs')
      .select(`
        id,
        file_url,
        status,
        uploaded_at,
        allocation_id,
        participant_id
      `)
      .eq('status', PROOF_STATUS.PENDING)
      .order('uploaded_at', { ascending: true });

    if (error) throw error;

    const enriched = await enrichProofRows(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * Approve purchase proof
 */
const approvePurchaseProof = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data } = await supabase
      .from('purchase_proofs')
      .update({ status: PROOF_STATUS.APPROVED })
      .eq('id', id)
      .eq('status', PROOF_STATUS.PENDING)
      .select('id, participant_id')
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Purchase proof not found or already processed'
      });
    }

    res.json({
      success: true,
      message: 'Purchase proof approved'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', data.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: 'Purchase proof approved',
        html: purchaseApprovedEmail()
      });
    }
  } catch (err) {
    next(err);
  }
};

/**
 * Get purchase proofs with optional status filter (Admin)
 */
const getPurchaseProofs = async (req, res, next) => {
  try {
    const status = String(req.query.status || "").toUpperCase();
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 100;

    let query = supabase
      .from('purchase_proofs')
      .select(
        `
        id,
        file_url,
        status,
        uploaded_at,
        allocation_id,
        participant_id
      `
      )
      .order('uploaded_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    const enriched = await enrichProofRows(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * Reject purchase proof
 */
const rejectPurchaseProof = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data } = await supabase
      .from('purchase_proofs')
      .update({ status: PROOF_STATUS.REJECTED })
      .eq('id', id)
      .eq('status', PROOF_STATUS.PENDING)
      .select('id, participant_id')
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Purchase proof not found or already processed'
      });
    }

    res.json({
      success: true,
      message: 'Purchase proof rejected'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', data.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: 'Purchase proof rejected',
        html: purchaseRejectedEmail()
      });
    }
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPurchaseProofs,
  getPendingPurchaseProofs,
  approvePurchaseProof,
  rejectPurchaseProof
};
