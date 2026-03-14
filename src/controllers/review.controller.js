const supabase = require('../config/supabaseClient');
const { PROOF_STATUS } = require('../utils/constants');
const { sendEmail } = require('../services/email.service');
const {
  purchaseApprovedEmail,
  purchaseRejectedEmail
} = require('../services/email.templates');

const { createPayoutIfBothApproved } = require('./payout.controller');

const buildAppMapKey = (participantId, projectId, productId) =>
  `${participantId}::${projectId}::${productId || '__none__'}`;

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

const fetchParticipantReviewRows = async (queryBuilder) => {
  let result = await queryBuilder(`
    id,
    feedback,
    rating,
    status,
    created_at,
    participant_id,
    project_id,
    product_id
  `);

  if (result.error && /product_id/i.test(String(result.error.message || ''))) {
    result = await queryBuilder(`
      id,
      feedback,
      rating,
      status,
      created_at,
      participant_id,
      project_id
    `);
  }

  return result;
};

const getApprovedApplicationMap = async (participantIds, projectIds) => {
  if (!participantIds.length || !projectIds.length) {
    return { byKey: new Map(), singleByProject: new Map() };
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
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
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
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
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

  const byKey = new Map();
  const productIdsByParticipantProject = new Map(); // pid::proj -> Set(product_id)
  const latestByParticipantProject = new Map(); // pid::proj -> { product_id, product_name }

  for (const row of appRows) {
    const participantProjectKey = `${row.participant_id}::${row.project_id}`;
    const productId = row.product_id || null;
    const productName = row?.project_products?.name || productMap.get(row.product_id)?.name || null;

    byKey.set(buildAppMapKey(row.participant_id, row.project_id, productId), {
      product_id: productId,
      product_name: productName
    });

    if (!productIdsByParticipantProject.has(participantProjectKey)) {
      productIdsByParticipantProject.set(participantProjectKey, new Set());
    }
    productIdsByParticipantProject.get(participantProjectKey).add(productId || '__none__');

    // appRows are ordered by created_at desc (when available), so the first seen is the latest.
    if (!latestByParticipantProject.has(participantProjectKey)) {
      latestByParticipantProject.set(participantProjectKey, { product_id: productId, product_name: productName });
    }
  }

  const singleByProject = new Map();
  for (const [participantProjectKey, productSet] of productIdsByParticipantProject.entries()) {
    if (productSet.size !== 1) continue;
    const only = Array.from(productSet)[0];
    const resolvedOnly = only === '__none__' ? null : only;
    const latest = latestByParticipantProject.get(participantProjectKey);
    singleByProject.set(participantProjectKey, {
      product_id: resolvedOnly,
      product_name: latest?.product_name || null
    });
  }

  return { byKey, singleByProject };
};

const enrichProofRows = async (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const allocationIds = [...new Set(rows.map((row) => row.allocation_id).filter(Boolean))];
  const participantIds = [...new Set(rows.map((row) => row.participant_id).filter(Boolean))];
  const productIdsFromRows = [...new Set(rows.map((row) => row.product_id).filter(Boolean))];

  const { data: allocations, error: allocationError } = allocationIds.length
    ? await supabase
        .from('unit_allocations')
        .select('id, project_id')
        .in('id', allocationIds)
    : { data: [], error: null };
  if (allocationError) throw allocationError;

  const allocationMap = new Map((allocations || []).map((item) => [item.id, item.project_id]));

  // Resolve the *actual* project_id for each proof via product_id -> project_applications -> project_id.
  // Allocation-level project_id can be misleading when a participant has products across projects.
  const productProjectMap = new Map(); // product_id -> project_id
  let productProjectIds = [];
  if (productIdsFromRows.length) {
    let appsRes = await supabase
      .from('project_applications')
      .select('product_id, project_id, created_at, status')
      .in('product_id', productIdsFromRows)
      .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
      .order('created_at', { ascending: false });

    if (appsRes.error && /created_at/i.test(String(appsRes.error.message || ''))) {
      appsRes = await supabase
        .from('project_applications')
        .select('product_id, project_id, status')
        .in('product_id', productIdsFromRows)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);
    }

    if (appsRes.error && !isMissingSchemaObjectError(appsRes.error)) throw appsRes.error;

    for (const app of (appsRes.data || [])) {
      if (!app?.product_id || !app?.project_id) continue;
      if (!productProjectMap.has(app.product_id)) {
        productProjectMap.set(app.product_id, app.project_id);
      }
    }

    productProjectIds = [...new Set(Array.from(productProjectMap.values()).filter(Boolean))];
  }

  const projectIds = [...new Set([
    ...(allocations || []).map((row) => row.project_id).filter(Boolean),
    ...productProjectIds
  ])];

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
  const appIndex = await getApprovedApplicationMap(participantIds, projectIds);
  const appMap = appIndex.byKey;
  const singleAppByParticipantProject = appIndex.singleByProject;
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
    const projectId =
      (row.product_id ? (productProjectMap.get(row.product_id) || null) : null)
      || allocationMap.get(row.allocation_id)
      || null;
    const profile = profileMap.get(row.participant_id) || {};

    const participantProjectKey = `${row.participant_id}::${projectId}`;
    const fallbackSingle = singleAppByParticipantProject.get(participantProjectKey) || null;
    const resolvedProductId = row.product_id || fallbackSingle?.product_id || null;
    const app = resolvedProductId
      ? (appMap.get(buildAppMapKey(row.participant_id, projectId, resolvedProductId)) || {})
      : {};

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

const enrichReviewRows = async (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const participantIds = [...new Set(rows.map((row) => row.participant_id).filter(Boolean))];
  const projectIds = [...new Set(rows.map((row) => row.project_id).filter(Boolean))];

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

  const { data: profiles, error: profileError } = participantIds.length
    ? await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', participantIds)
    : { data: [], error: null };
  if (profileError) throw profileError;

  const profileMap = new Map((profiles || []).map((item) => [item.id, item]));
  const appIndex = await getApprovedApplicationMap(participantIds, projectIds);
  const singleAppByParticipantProject = appIndex.singleByProject;
  const directProductMap = await getProductNameMap([
    ...rows.map((row) => row.product_id),
    ...Array.from(singleAppByParticipantProject.values()).map((v) => v?.product_id)
  ]);

  return rows.map((row) => {
    const profile = profileMap.get(row.participant_id) || {};
    const participantProjectKey = `${row.participant_id}::${row.project_id}`;
    const fallbackSingle = singleAppByParticipantProject.get(participantProjectKey) || null;
    const productId = row.product_id || fallbackSingle?.product_id || null;

    return {
      ...row,
      project_name: projectMap.get(row.project_id) || null,
      product_name: directProductMap.get(productId)?.name || null,
      participant_name: profile.full_name || null,
      participant_email: profile.email || null
    };
  });
};

// ────────────────────────────────────────────────────────────────────────────────
// PURCHASE PROOF (INVOICE) FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────────

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
 * ✅ Approve purchase proof (Invoice)
 * FIX: Call createPayoutIfBothApproved to create payout if review is also approved
 */
const approvePurchaseProof = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('purchase_proofs')
      .update({ status: PROOF_STATUS.APPROVED })
      .eq('id', id)
      .eq('status', PROOF_STATUS.PENDING)
      .select('id, participant_id, allocation_id, product_id')
      .maybeSingle();
    if (error) throw error;

    let proof = data;
    let alreadyProcessed = false;

    if (!proof) {
      const { data: existingById, error: existingByIdError } = await supabase
        .from('purchase_proofs')
        .select('id, participant_id, allocation_id, product_id, status')
        .eq('id', id)
        .maybeSingle();
      if (existingByIdError) throw existingByIdError;

      if (existingById) {
        proof = existingById;
        alreadyProcessed = String(existingById.status || '').toUpperCase() === PROOF_STATUS.APPROVED;
      } else {
        const { data: existingByAllocation, error: existingByAllocationError } = await supabase
          .from('purchase_proofs')
          .select('id, participant_id, allocation_id, product_id, status')
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
            .select('id, participant_id, allocation_id, product_id')
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

    // Resolve project_id via the participant's application for this product.
    // allocation.project_id is NOT reliable across products/projects.
    let resolvedProjectId = allocation?.project_id || null;
    if (proof.participant_id && proof.product_id) {
      const { data: appForProduct, error: appForProductError } = await supabase
        .from('project_applications')
        .select('project_id, created_at')
        .eq('participant_id', proof.participant_id)
        .eq('product_id', proof.product_id)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (appForProductError) {
        console.warn('[approvePurchaseProof] Could not resolve project_id via project_applications:', appForProductError.message || appForProductError);
      } else if (appForProduct?.project_id) {
        resolvedProjectId = appForProduct.project_id;
      }
    }

    // ── TRY TO CREATE PAYOUT (if review is also approved) ──
    if (resolvedProjectId && proof.product_id) {
      const payoutId = await createPayoutIfBothApproved({
        participantId: proof.participant_id,
        projectId: resolvedProjectId,
        productId: proof.product_id
      });
      
      if (payoutId) {
        console.log(`[approvePurchaseProof] Payout created: ${payoutId}`);
      }
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

    const { data: proofProj } = resolvedProjectId
      ? await supabase.from('projects').select('title, name').eq('id', resolvedProjectId).maybeSingle()
      : { data: null };
    const reviewProjName = proofProj?.title || proofProj?.name || null;
    const approvedProducts = resolvedProjectId
      ? await getApprovedProductsForParticipantProject(proof.participant_id, resolvedProjectId)
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

// ────────────────────────────────────────────────────────────────────────────────
// PARTICIPANT REVIEW FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Get all pending participant reviews (Admin)
 */
const getPendingParticipantReviews = async (req, res, next) => {
  try {
    const { data, error } = await fetchParticipantReviewRows((fields) =>
      supabase
        .from('participant_reviews')
        .select(fields)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: true })
    );

    if (error) throw error;

    const enriched = await enrichReviewRows(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * ✅ Approve participant review
 * FIX: Call createPayoutIfBothApproved to create payout if invoice is also approved
 */
const approveParticipantReview = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Update review status
    const { data, error } = await supabase
      .from('participant_reviews')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, participant_id, project_id, product_id')
      .maybeSingle();

    if (error) throw error;

    let review = data;
    let alreadyProcessed = false;

    if (!review) {
      const { data: existingById, error: existingByIdError } = await supabase
        .from('participant_reviews')
        .select('id, participant_id, project_id, product_id, status')
        .eq('id', id)
        .maybeSingle();
      if (existingByIdError) throw existingByIdError;

      if (existingById) {
        review = existingById;
        alreadyProcessed = String(existingById.status || '').toUpperCase() === 'APPROVED';
      } else {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }
    }

    // ── TRY TO CREATE PAYOUT (if invoice is also approved) ──
    // Resolve project_id via project_applications (review.project_id may be allocation-derived in legacy rows).
    let resolvedProjectId = review.project_id || null;
    if (review.participant_id && review.product_id) {
      const { data: appForProduct, error: appForProductError } = await supabase
        .from('project_applications')
        .select('project_id, created_at')
        .eq('participant_id', review.participant_id)
        .eq('product_id', review.product_id)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (appForProductError) {
        console.warn('[approveParticipantReview] Could not resolve project_id via project_applications:', appForProductError.message || appForProductError);
      } else if (appForProduct?.project_id) {
        resolvedProjectId = appForProduct.project_id;
      }
    }

    if (review.product_id && resolvedProjectId) {
      const payoutId = await createPayoutIfBothApproved({
        participantId: review.participant_id,
        projectId: resolvedProjectId,
        productId: review.product_id
      });

      if (payoutId) {
        console.log(`[approveParticipantReview] Payout created: ${payoutId}`);
      }
    }

    res.json({
      success: true,
      message: alreadyProcessed
        ? 'Review already approved'
        : 'Review approved successfully'
    });

    // Send confirmation email
    const { data: participant } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', review.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '✅ Your Review Has Been Approved',
        html: `
          <h2>Review Approved</h2>
          <p>Hi ${participant.full_name},</p>
          <p>Your review has been approved by our admin team. Your payout will be processed soon!</p>
          <p>Track your reimbursement status on the <a href="${process.env.FRONTEND_URL}/payouts">Payouts page</a>.</p>
        `
      });
    }

  } catch (err) {
    next(err);
  }
};

/**
 * Get participant reviews with optional status filter (Admin)
 */
const getParticipantReviews = async (req, res, next) => {
  try {
    const status = String(req.query.status || "").toUpperCase();
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 100;

    const { data, error } = await fetchParticipantReviewRows((fields) => {
      let query = supabase
        .from('participant_reviews')
        .select(fields)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (status) {
        query = query.eq('status', status);
      }

      return query;
    });

    if (error) throw error;

    const enriched = await enrichReviewRows(data || []);
    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

/**
 * Reject participant review
 */
const rejectParticipantReview = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data } = await supabase
      .from('participant_reviews')
      .update({ status: 'REJECTED' })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, participant_id')
      .maybeSingle();

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or already processed'
      });
    }

    res.json({
      success: true,
      message: 'Review rejected'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', data.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '⚠️ Action Required: Re-submit Your Review',
        html: `
          <h2>Review Needs Revision</h2>
          <p>Hi ${participant.full_name},</p>
          <p>Your review was not approved and needs revision. Please re-submit your feedback for this product.</p>
          <p>Go to your <a href="${process.env.FRONTEND_URL}/allocation/active">Tasks page</a> to re-submit.</p>
        `
      });
    }
  } catch (err) {
    next(err);
  }
};

module.exports = {
  // Purchase Proof (Invoice)
  getPurchaseProofs,
  getPendingPurchaseProofs,
  approvePurchaseProof,
  rejectPurchaseProof,
  
  // Participant Review
  getParticipantReviews,
  getPendingParticipantReviews,
  approveParticipantReview,
  rejectParticipantReview
};
