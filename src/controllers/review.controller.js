const supabase = require('../config/supabaseClient');
const { PROOF_STATUS } = require('../utils/constants');
const { sendEmail } = require('../services/email.service');
const {
  purchaseApprovedEmail,
  purchaseRejectedEmail
} = require('../services/email.templates');

const { ensureEligiblePayout } = require('./submission.controller');

const buildAppMapKey = (participantId, projectId) => `${participantId}::${projectId}`;

const getApprovedProductsForParticipantProject = async (participantId, projectId) => {
  if (!participantId || !projectId) return [];

  const { data, error } = await supabase
    .from('project_applications')
    .select(
      `
      product_id,
      project_products (
        id,
        name,
        image_url,
        product_value
      )
    `
    )
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);

  if (error) throw error;

  const seen = new Set();
  return (data || [])
    .map((row) => row?.project_products)
    .filter((product) => {
      if (!product?.id || seen.has(product.id)) return false;
      seen.add(product.id);
      return true;
    })
    .map((product) => ({
      id: product.id,
      name: product.name,
      image_url: product.image_url || null,
      product_value: product.product_value || null
    }));
};

const getProductNameMap = async (productIds) => {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from('project_products')
    .select('id, name')
    .in('id', ids);
  if (error) throw error;

  return new Map((data || []).map((item) => [item.id, item]));
};

const fetchPurchaseProofRows = async (queryBuilder) => {
  let result = await queryBuilder(`
    id,
    file_url,
    status,
    uploaded_at,
    allocation_id,
    participant_id,
    product_id
  `);

  if (result.error && /product_id/i.test(String(result.error.message || ''))) {
    result = await queryBuilder(`
      id,
      file_url,
      status,
      uploaded_at,
      allocation_id,
      participant_id
    `);
  }

  return result;
};

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
    .in('status', ['APPROVED', 'PURCHASED'])
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
      .in('status', ['APPROVED', 'PURCHASED']);
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
  const { data: profiles, error: profileError } = participantIds.length
    ? await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', participantIds)
    : { data: [], error: null };
  if (profileError) throw profileError;

  const profileMap = new Map((profiles || []).map((item) => [item.id, item]));
  const directProductMap = await getProductNameMap(rows.map((row) => row.product_id));

  return rows.map((row) => {
    const projectId = allocationMap.get(row.allocation_id) || null;
    const app = appMap.get(buildAppMapKey(row.participant_id, projectId)) || {};
    const profile = profileMap.get(row.participant_id) || {};
    const resolvedProductId = row.product_id || app.product_id || null;

    return {
      ...row,
      project_id: projectId,
      project_name: projectMap.get(projectId) || null,
      product_id: resolvedProductId,
      product_name: directProductMap.get(resolvedProductId)?.name || app.product_name || null,
      participant_name: profile.full_name || null,
      participant_email: profile.email || null
    };
  });
};

/**
 * Get all pending purchase proofs (Admin)
 */
const getPendingPurchaseProofs = async (req, res, next) => {
  try {
    const { data, error } = await fetchPurchaseProofRows((fields) =>
      supabase
        .from('purchase_proofs')
        .select(fields)
        .eq('status', PROOF_STATUS.PENDING)
        .order('uploaded_at', { ascending: true })
    );

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

    const { data, error } = await supabase
      .from('purchase_proofs')
      .update({ status: PROOF_STATUS.APPROVED })
      .eq('id', id)
      .eq('status', PROOF_STATUS.PENDING)
      .select('id, participant_id, allocation_id')
      .maybeSingle();
    if (error) throw error;

    let proof = data;
    let alreadyProcessed = false;

    if (!proof) {
      const { data: existingById, error: existingByIdError } = await supabase
        .from('purchase_proofs')
        .select('id, participant_id, allocation_id, status')
        .eq('id', id)
        .maybeSingle();
      if (existingByIdError) throw existingByIdError;

      if (existingById) {
        proof = existingById;
        alreadyProcessed = String(existingById.status || '').toUpperCase() === PROOF_STATUS.APPROVED;
      } else {
        const { data: existingByAllocation, error: existingByAllocationError } = await supabase
          .from('purchase_proofs')
          .select('id, participant_id, allocation_id, status')
          .eq('allocation_id', id)
          .order('uploaded_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingByAllocationError) throw existingByAllocationError;

        if (!existingByAllocation) {
          return res.status(404).json({
            success: false,
            message: 'Purchase proof not found'
          });
        }

        proof = existingByAllocation;
        if (String(existingByAllocation.status || '').toUpperCase() === PROOF_STATUS.PENDING) {
          const { data: promoted, error: promotedError } = await supabase
            .from('purchase_proofs')
            .update({ status: PROOF_STATUS.APPROVED })
            .eq('id', existingByAllocation.id)
            .eq('status', PROOF_STATUS.PENDING)
            .select('id, participant_id, allocation_id')
            .maybeSingle();
          if (promotedError) throw promotedError;
          if (promoted) {
            proof = promoted;
          } else {
            alreadyProcessed = true;
          }
        } else {
          alreadyProcessed = true;
        }
      }
    }

    const { data: allocation } = await supabase
      .from('unit_allocations')
      .select('project_id')
      .eq('id', proof.allocation_id)
      .maybeSingle();

    if (allocation?.project_id) {
      await ensureEligiblePayout({
        participantId: proof.participant_id,
        projectId: allocation.project_id
      });
    }

    res.json({
      success: true,
      message: alreadyProcessed
        ? 'Purchase proof already approved'
        : 'Purchase proof approved'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', proof.participant_id)
      .maybeSingle();

    const { data: proofProj } = allocation?.project_id
      ? await supabase.from('projects').select('title, name').eq('id', allocation.project_id).maybeSingle()
      : { data: null };
    const reviewProjName = proofProj?.title || proofProj?.name || null;
    const approvedProducts = allocation?.project_id
      ? await getApprovedProductsForParticipantProject(proof.participant_id, allocation.project_id)
      : [];

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '✅ Invoice Approved — Submit Your Review',
        html: purchaseApprovedEmail(participant.full_name, reviewProjName, approvedProducts)
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

    const { data, error } = await fetchPurchaseProofRows((fields) => {
      let query = supabase
        .from('purchase_proofs')
        .select(fields)
        .order('uploaded_at', { ascending: false })
        .limit(limit);

      if (status) {
        query = query.eq('status', status);
      }

      return query;
    });
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
      .select('email, full_name')
      .eq('id', data.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '⚠️ Action Required: Re-upload Your Invoice',
        html: purchaseRejectedEmail(participant.full_name, null)
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
