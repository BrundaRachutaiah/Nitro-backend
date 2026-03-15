const supabase = require('../config/supabaseClient');
const { sendEmail } = require('../services/email.service');
const {
  reviewApprovedEmail,
  reviewRejectedEmail
} = require('../services/email.templates');
const { calculatePayoutBreakdown } = require('../utils/payout.utils');
const { ALLOCATION_STATUS } = require('../utils/constants');
const { createPayoutIfBothApproved } = require('./payout.controller');

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

// Detects PostgreSQL unique constraint violations (error code 23505)
const isUniqueConstraintError = (error) => {
  const code = String(error?.code || '');
  const msg  = String(error?.message || '').toLowerCase();
  return (
    code === '23505'
    || msg.includes('duplicate key')
    || msg.includes('unique constraint')
    || msg.includes('violates unique')
  );
};

const extractUrlMatches = (value) => {
  const text = String(value || '');
  return text.match(/https?:\/\/[^\s)]+/g) || [];
};

const buildReviewScreenshotData = ({ reviewUrl, reviewText }) => {
  const screenshots = [];
  const seen = new Set();

  const addScreenshot = (url) => {
    const normalized = String(url || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    screenshots.push(normalized);
  };

  addScreenshot(reviewUrl);
  extractUrlMatches(reviewText).forEach(addScreenshot);

  const reviewTextDisplay = String(reviewText || '')
    .replace(/\n?\s*(Extra screenshots|Screenshots):\s*\n?([\s\S]*)$/i, '')
    .trim();

  return {
    review_screenshots: screenshots,
    review_text_display: reviewTextDisplay || null
  };
};

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

const fetchReviewRows = async (queryBuilder) => {
  let result = await queryBuilder('id, allocation_id, participant_id, project_id, product_id, review_text, review_url, status, created_at');

  if (result.error && /product_id/i.test(String(result.error.message || ''))) {
    result = await queryBuilder('id, allocation_id, participant_id, project_id, review_text, review_url, status, created_at');
  }

  return result;
};

const markAllocationCompleted = async ({ allocationId, participantId }) => {
  const completionRes = await supabase
    .from('unit_allocations')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', allocationId)
    .eq('participant_id', participantId)
    .is('completed_at', null);

  if (completionRes.error && isMissingSchemaObjectError(completionRes.error)) {
    const statusOnlyRes = await supabase
      .from('unit_allocations')
      .update({ status: ALLOCATION_STATUS.COMPLETED })
      .eq('id', allocationId)
      .eq('participant_id', participantId);

    if (statusOnlyRes.error && !isMissingSchemaObjectError(statusOnlyRes.error)) {
      throw statusOnlyRes.error;
    }
    return;
  }

  if (completionRes.error) throw completionRes.error;
};

const markApplicationCompleted = async ({ participantId, projectId, productId }) => {
  if (!participantId || !projectId) return;

  // ── FIX: Only mark the OLDEST active application as completed ────────────
  // Previously this updated ALL APPROVED/PURCHASED rows for the product,
  // which incorrectly completed the NEW cycle application immediately.
  // Now we find the single oldest APPROVED/PURCHASED row and complete only that.

  // Step 1: Find the oldest active application for this product
  let findQuery = supabase
    .from('project_applications')
    .select('id')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'PURCHASED'])
    .order('created_at', { ascending: true })  // oldest first
    .limit(1);

  if (productId) {
    findQuery = findQuery.eq('product_id', productId);
  }

  const { data: oldestApp, error: findError } = await findQuery.maybeSingle();

  if (findError && isMissingSchemaObjectError(findError)) {
    // Schema fallback — just update all matching rows
    let fallbackQuery = supabase
      .from('project_applications')
      .update({ status: 'COMPLETED', reviewed_at: new Date().toISOString() })
      .eq('participant_id', participantId)
      .eq('project_id', projectId)
      .in('status', ['APPROVED', 'PURCHASED']);

    if (productId) {
      fallbackQuery = fallbackQuery.eq('product_id', productId);
    }

    const result = await fallbackQuery;
    if (result.error && !isMissingSchemaObjectError(result.error)) {
      throw result.error;
    }
    return;
  }

  if (findError) throw findError;
  if (!oldestApp?.id) return; // no active application found

  // Step 2: Complete only that specific row by ID
  const { error: updateError } = await supabase
    .from('project_applications')
    .update({
      status: 'COMPLETED',
      reviewed_at: new Date().toISOString()
    })
    .eq('id', oldestApp.id);

  if (updateError && !isMissingSchemaObjectError(updateError)) {
    throw updateError;
  }
};

const buildAppMapKey = (participantId, projectId, productId) =>
  `${participantId}::${projectId}::${productId || '__none__'}`;

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
  const directProductMap = await getProductNameMap([
    ...rows.map((row) => row.product_id),
    ...Array.from(singleAppByParticipantProject.values()).map((v) => v?.product_id)
  ]);

  return rows.map((row) => {
    const profile = profileMap.get(row.participant_id) || {};

    const participantProjectKey = `${row.participant_id}::${row.project_id}`;
    const fallbackSingle = singleAppByParticipantProject.get(participantProjectKey) || null;
    const resolvedProductId = row.product_id || fallbackSingle?.product_id || null;
    const app = resolvedProductId
      ? (appMap.get(buildAppMapKey(row.participant_id, row.project_id, resolvedProductId)) || {})
      : {};

    const screenshotData = buildReviewScreenshotData({
      reviewUrl: row.review_url,
      reviewText: row.review_text
    });
    return {
      ...row,
      project_name: projectMap.get(row.project_id) || null,
      product_id: resolvedProductId,
      product_name: directProductMap.get(resolvedProductId)?.name || app.product_name || null,
      participant_name: profile.full_name || null,
      participant_email: profile.email || null,
      ...screenshotData
    };
  });
};

const getAllocationContext = async (allocationId, participantId) => {
  const { data: allocation, error } = await supabase
    .from('unit_allocations')
    .select(
      `
      id,
      participant_id,
      project_id,
      projects (
        id,
        mode,
        reward
      )
    `
    )
    .eq('id', allocationId)
    .eq('participant_id', participantId)
    .maybeSingle();

  if (error) throw error;
  return allocation;
};

const getProofStatus = async (allocationId, participantId) => {
  // Use limit(1) + select as array to safely handle allocations with multiple products
  // (.maybeSingle() throws when >1 row exists)
  const { data, error } = await supabase
    .from('purchase_proofs')
    .select('id, status')
    .eq('allocation_id', allocationId)
    .eq('participant_id', participantId)
    .limit(1);

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) return null;
  return String(row?.status || '').toUpperCase() || 'PENDING';
};

const getProofStatusByProduct = async (allocationId, participantId, productId) => {
  if (!productId) return getProofStatus(allocationId, participantId);

  let lookup = await supabase
    .from('purchase_proofs')
    .select('id, status')
    .eq('allocation_id', allocationId)
    .eq('participant_id', participantId)
    .eq('product_id', productId)
    .maybeSingle();

  if (lookup.error && isMissingSchemaObjectError(lookup.error)) {
    // product_id column doesn't exist — fall back to allocation-level check
    // getProofStatus now safely handles multiple rows via limit(1)
    return getProofStatus(allocationId, participantId);
  }
  if (lookup.error) throw lookup.error;

  // If no row found by product_id, also try allocation-level as fallback
  // (handles the case where proof was inserted without product_id)
  if (!lookup.data?.id) {
    return getProofStatus(allocationId, participantId);
  }
  return String(lookup.data?.status || '').toUpperCase() || 'PENDING';
};

const ensureEligiblePayout = async ({ participantId, projectId }) => {
  if (!participantId || !projectId) return;

  // ── Step 1: Check project mode ───────────────────────────────────────────
  const { data: project } = await supabase
    .from('projects')
    .select('id, reward, mode')
    .eq('id', projectId)
    .maybeSingle();

  const rewardAmount = Number(project?.reward || 0);
  const mode = String(project?.mode || '').toUpperCase();

  // ── Step 2: Find approved reviews for this participant in this project ────
  // Reviews can store project_id directly OR link via allocation_id → unit_allocations
  let allReviewsRes = await supabase
    .from('participant_reviews')
    .select('id, allocation_id, project_id, product_id, status')
    .eq('participant_id', participantId)
    .eq('status', 'APPROVED');

  if (allReviewsRes.error && /product_id/i.test(String(allReviewsRes.error.message || ''))) {
    allReviewsRes = await supabase
      .from('participant_reviews')
      .select('id, allocation_id, project_id, status')
      .eq('participant_id', participantId)
      .eq('status', 'APPROVED');
  }

  if (allReviewsRes.error) throw allReviewsRes.error;
  const allReviews = allReviewsRes.data || [];

  const reviews = (allReviews || []).filter(r => {
    // Match by direct project_id if present
    if (r.project_id) return r.project_id === projectId;
    // Otherwise we need to resolve via allocation (done below)
    return true; // keep all for now, filter after allocation lookup
  });

  // Resolve allocation_id → project_id for reviews without project_id
  const reviewAllocIds = reviews.filter(r => !r.project_id).map(r => r.allocation_id).filter(Boolean);
  let reviewAllocMap = new Map();
  if (reviewAllocIds.length) {
    const { data: allocs } = await supabase
      .from('unit_allocations')
      .select('id, project_id')
      .in('id', reviewAllocIds);
    reviewAllocMap = new Map((allocs || []).map(a => [a.id, a.project_id]));
  }

  const approvedReviews = reviews.filter(r => {
    const resolvedProject = r.project_id || reviewAllocMap.get(r.allocation_id);
    return resolvedProject === projectId;
  });

  const hasApprovedReview = approvedReviews.length > 0;
  const approvedReviewProductIds = new Set(
    approvedReviews
      .map((r) => r?.product_id)
      .filter(Boolean)
      .map((id) => String(id))
  );

  // ── Step 3: Find approved proofs for this participant in this project ─────
  // Proofs only have allocation_id, no project_id — resolve via unit_allocations
  let allProofsRes = await supabase
    .from('purchase_proofs')
    .select('id, allocation_id, product_id, status')
    .eq('participant_id', participantId)
    .eq('status', 'APPROVED');

  if (allProofsRes.error && /product_id/i.test(String(allProofsRes.error.message || ''))) {
    allProofsRes = await supabase
      .from('purchase_proofs')
      .select('id, allocation_id, status')
      .eq('participant_id', participantId)
      .eq('status', 'APPROVED');
  }

  if (allProofsRes.error) throw allProofsRes.error;
  const allProofs = allProofsRes.data || [];

  const proofAllocIds = (allProofs || []).map(p => p.allocation_id).filter(Boolean);
  let proofAllocMap = new Map();
  if (proofAllocIds.length) {
    const { data: proofAllocs } = await supabase
      .from('unit_allocations')
      .select('id, project_id')
      .in('id', proofAllocIds);
    proofAllocMap = new Map((proofAllocs || []).map(a => [a.id, a.project_id]));
  }

  // FIX: also directly match proofs whose allocation belongs to this project
  // This catches cases where the allocation lookup returns empty (completed/status issues)
  const approvedProofs = (allProofs || []).filter(p => {
    // Direct match via allocation map
    if (proofAllocMap.get(p.allocation_id) === projectId) return true;
    // Fallback: if proof's allocation_id matches the calling allocation's project
    // (unit_allocations may have been completed and excluded from lookup)
    return false;
  });

  const approvedProofProductIds = new Set(
    approvedProofs
      .map((p) => p?.product_id)
      .filter(Boolean)
      .map((id) => String(id))
  );
  const approvedProofIdByProduct = new Map();
  for (const proof of approvedProofs) {
    if (!proof?.product_id) continue;
    const key = String(proof.product_id);
    if (!approvedProofIdByProduct.has(key)) approvedProofIdByProduct.set(key, proof.id);
  }

  // Also check if ANY of the participant's allocations for this project have approved proofs
  // by querying unit_allocations for this project directly
  let hasApprovedProof = approvedProofs.length > 0;
  if (!hasApprovedProof && proofAllocIds.length) {
    const { data: projectAllocations } = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('participant_id', participantId)
      .eq('project_id', projectId);
    const projectAllocIdSet = new Set((projectAllocations || []).map(a => a.id));
    hasApprovedProof = (allProofs || []).some(p => projectAllocIdSet.has(p.allocation_id));
  }

  // ── Step 4: Check eligibility based on project mode ──────────────────────
  let eligible = false;
  if (mode === 'MARKETPLACE') {
    eligible = hasApprovedReview; // marketplace: review only
  } else {
    eligible = hasApprovedProof && hasApprovedReview; // D2C / default: BOTH required
  }

  if (!eligible) return; // participant not eligible yet

  // ── Step 5: Get applications (one per product) ───────────────────────────
  const { data: applications, error: appError } = await supabase
    .from('project_applications')
    .select('id, product_id, allocated_budget')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);

  if (appError && !isMissingSchemaObjectError(appError)) throw appError;
  const apps = applications || [];

  // ── Step 6: Get already-covered products to avoid duplicates ─────────────
  // FIX: Only check payouts from the CURRENT cycle, not old PAID ones.
  // Old PAID payouts from previous cycles must NOT block new cycle payouts.
  const { data: currentCycleApps } = await supabase
    .from('project_applications')
    .select('id, product_id, created_at')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
    .order('created_at', { ascending: false })
    .limit(20);

  // Find the most recent application date = start of current cycle
  const currentCycleStart = (currentCycleApps || []).reduce((latest, app) => {
    const t = new Date(app.created_at || 0).getTime();
    return t > latest ? t : latest;
  }, 0);

  // Only count payouts created after current cycle started (1 min buffer)
  const currentCycleDate = currentCycleStart > 0
    ? new Date(currentCycleStart - 60000).toISOString()
    : new Date(0).toISOString();

  const { data: existingPayouts } = await supabase
    .from('payouts')
    .select('id, product_id')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['ELIGIBLE', 'IN_BATCH', 'EXPORTED', 'PAID'])
    .gte('created_at', currentCycleDate);

  const coveredProductIds = new Set(
    (existingPayouts || []).map(p => p.product_id || '__none__')
  );

  // ── Step 7: Create payout for each uncovered product ─────────────────────
  const insertPayout = async (payload) => {
    const candidates = [
      { ...payload },
      { ...payload, user_id: undefined },
      { ...payload, purchase_proof_id: undefined },
      { ...payload, user_id: undefined, purchase_proof_id: undefined },
      { ...payload, product_id: undefined, user_id: undefined, purchase_proof_id: undefined },
    ];
    for (const candidate of candidates) {
      // Clean undefined keys
      const clean = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
      const { error } = await supabase.from('payouts').insert(clean);
      if (!error) return true;
      if (!isMissingSchemaObjectError(error)) throw error;
    }
    return false;
  };

  if (apps.length > 0) {
    for (const application of apps) {
      const productKey = application.product_id || '__none__';
      if (coveredProductIds.has(productKey)) continue;

      // Eligibility must be evaluated per product to avoid cross-product leakage.
      const productIdStr = application.product_id ? String(application.product_id) : null;
      const hasProductScopedReviews = approvedReviewProductIds.size > 0;
      const hasProductScopedProofs = approvedProofProductIds.size > 0;

      const productHasApprovedReview = (productIdStr && hasProductScopedReviews)
        ? approvedReviewProductIds.has(productIdStr)
        : hasApprovedReview;
      const productHasApprovedProof = (productIdStr && hasProductScopedProofs)
        ? approvedProofProductIds.has(productIdStr)
        : hasApprovedProof;

      const eligibleForThisProduct = mode === 'MARKETPLACE'
        ? productHasApprovedReview
        : (productHasApprovedProof && productHasApprovedReview);

      if (!eligibleForThisProduct) continue;

      const canonicalProofId = productIdStr
        ? (approvedProofIdByProduct.get(productIdStr) || approvedProofs[0]?.id || null)
        : (approvedProofs[0]?.id || null);

      let productAmount = Number(application.allocated_budget || 0);
      if (!productAmount && application.product_id) {
        const { data: prod } = await supabase
          .from('project_products')
          .select('product_value')
          .eq('id', application.product_id)
          .maybeSingle();
        productAmount = Number(prod?.product_value || 0);
      }

      // ── BUG 6 FIX: amount = productAmount only — no reward component ─────────
      // The participant payouts page shows product_value only (not reward + product).
      // backfillEligiblePayouts and backfillPayoutsForParticipant also use product_value
      // only. Using rewardAmount + productAmount here caused inflated payout amounts
      // that were inconsistent with what participants actually received.
      const inserted = await insertPayout({
        participant_id: participantId,
        user_id: participantId,
        project_id: projectId,
        product_id: application.product_id || null,
        purchase_proof_id: canonicalProofId,
        amount: productAmount,
        status: 'ELIGIBLE',
      });
      if (inserted) coveredProductIds.add(productKey);
    }
  } else {
    // No applications — create a reward-only payout if not covered
    if (!coveredProductIds.has('__none__')) {
      const canonicalProofId = approvedProofs[0]?.id || null;
      await insertPayout({
        participant_id: participantId,
        user_id: participantId,
        project_id: projectId,
        purchase_proof_id: canonicalProofId,
        amount: rewardAmount,
        status: 'ELIGIBLE',
      });
    }
  }
};

const submitFeedback = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId, productId, rating, feedbackText } = req.body;

    if (!allocationId || !rating || !feedbackText) {
      return res.status(400).json({
        success: false,
        message: 'allocationId, rating, and feedbackText are required'
      });
    }

    const allocation = await getAllocationContext(allocationId, participantId);
    if (!allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const projectMode = String(allocation?.projects?.mode || '').toUpperCase();
    if (projectMode !== 'MARKETPLACE') {
      return res.status(400).json({
        success: false,
        message: 'Internal feedback is only allowed for Marketplace mode'
      });
    }

    const proofStatus = await getProofStatusByProduct(allocationId, participantId, productId);
    if (proofStatus !== 'APPROVED') {
      return res.status(400).json({
        success: false,
        message: 'Approved purchase proof is required before feedback submission'
      });
    }

    // Scope review-proof check to the specific product to avoid a review for
    // Product B blocking feedback for Product A.
    let reviewProofQuery = supabase
      .from('participant_reviews')
      .select('id, status')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId)
      .neq('status', 'REJECTED');

    let reviewProofRes = await (productId
      ? reviewProofQuery.eq('product_id', productId).maybeSingle()
      : reviewProofQuery.is('product_id', null).maybeSingle());

    if (reviewProofRes.error && isMissingSchemaObjectError(reviewProofRes.error)) {
      reviewProofRes = await supabase
        .from('participant_reviews')
        .select('id, status')
        .eq('allocation_id', allocationId)
        .eq('participant_id', participantId)
        .neq('status', 'REJECTED')
        .maybeSingle();
    }

    const reviewProofError = reviewProofRes.error;
    const reviewProof = reviewProofRes.data;

    if (reviewProofError) throw reviewProofError;
    if (!reviewProof) {
      return res.status(400).json({
        success: false,
        message: 'Marketplace review screenshot is required before feedback submission'
      });
    }

    const normalizedRating = Number(rating);
    if (!Number.isFinite(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
      return res.status(400).json({
        success: false,
        message: 'rating must be between 1 and 5'
      });
    }

    // Scope feedback duplicate check to the specific product
    let existingRes = await (productId
      ? supabase.from('internal_feedbacks').select('id').eq('allocation_id', allocationId).eq('participant_id', participantId).eq('product_id', productId).maybeSingle()
      : supabase.from('internal_feedbacks').select('id').eq('allocation_id', allocationId).eq('participant_id', participantId).is('product_id', null).maybeSingle());

    if (existingRes.error && isMissingSchemaObjectError(existingRes.error)) {
      existingRes = await supabase
        .from('internal_feedbacks')
        .select('id')
        .eq('allocation_id', allocationId)
        .eq('participant_id', participantId)
        .maybeSingle();
    }

    const existingError = existingRes.error;
    const existing = existingRes.data;

    if (existingError) throw existingError;
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Feedback already submitted for this allocation'
      });
    }

    let insertRes = await supabase
      .from('internal_feedbacks')
      .insert({
        allocation_id: allocationId,
        participant_id: participantId,
        product_id: productId || null,
        project_id: allocation.project_id,
        rating: normalizedRating,
        feedback_text: String(feedbackText).trim()
      })
      .select()
      .maybeSingle();

    if (insertRes.error && isMissingSchemaObjectError(insertRes.error)) {
      const fallback = await supabase
        .from('internal_feedbacks')
        .insert({
          allocation_id: allocationId,
          participant_id: participantId,
          project_id: allocation.project_id,
          rating: normalizedRating,
          feedback_text: String(feedbackText).trim()
        });
      if (fallback.error && !isMissingSchemaObjectError(fallback.error)) {
        insertRes = { data: null, error: fallback.error };
      } else {
        const fetchBack = await supabase
          .from('internal_feedbacks')
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

    await ensureEligiblePayout({
      participantId,
      projectId: allocation.project_id,
      fallbackReward: allocation?.projects?.reward
    });

    await markAllocationCompleted({ allocationId, participantId });

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data
    });
  } catch (err) {
    next(err);
  }
};

const submitReview = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId, productId, reviewText, reviewUrl } = req.body;

    if (!allocationId) {
      return res.status(400).json({
        success: false,
        message: 'allocationId is required'
      });
    }

    const allocation = await getAllocationContext(allocationId, participantId);
    if (!allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const projectMode = String(allocation?.projects?.mode || '').toUpperCase();
    if (!['D2C', 'MARKETPLACE'].includes(projectMode)) {
      return res.status(400).json({
        success: false,
        message: 'Review submission is not enabled for this project mode'
      });
    }

    if (projectMode === 'MARKETPLACE' && !reviewUrl) {
      return res.status(400).json({
        success: false,
        message: 'Marketplace mode requires review screenshot URL'
      });
    }

    if (projectMode === 'D2C' && !reviewText && !reviewUrl) {
      return res.status(400).json({
        success: false,
        message: 'Review text or review URL is required when submitting a D2C review'
      });
    }

    const proofStatus = await getProofStatusByProduct(allocationId, participantId, productId);
    if (!proofStatus || proofStatus === 'REJECTED') {
      return res.status(400).json({
        success: false,
        message: 'Upload purchase proof before review submission'
      });
    }

    // Build the duplicate-check query.
    // IMPORTANT: When productId is provided we must filter by that specific product.
    // Using .eq('product_id', null) would match ALL rows whose product_id IS NULL,
    // which incorrectly blocks reviews for other products in the same allocation.
    let existingBaseQuery = supabase
      .from('participant_reviews')
      .select('id, status')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId);

    let existingRes;
    if (productId) {
      // Filter to this specific product only
      existingRes = await existingBaseQuery.eq('product_id', productId).maybeSingle();
    } else {
      // No productId — use IS NULL so we only match allocation-level reviews
      existingRes = await existingBaseQuery.is('product_id', null).maybeSingle();
    }

    if (existingRes.error && isMissingSchemaObjectError(existingRes.error)) {
      if (productId) {
        // Schema doesn't have product_id column yet — cannot safely check per-product.
        // Skip fallback to avoid incorrectly blocking reviews for other products.
        existingRes = { data: null, error: null };
      } else {
        existingRes = await supabase
          .from('participant_reviews')
          .select('id, status')
          .eq('allocation_id', allocationId)
          .eq('participant_id', participantId)
          .maybeSingle();
      }
    }

    const existingError = existingRes.error;
    const existing = existingRes.data;

    if (existingError) throw existingError;
    const existingStatus = String(existing?.status || '').toUpperCase();
    if (existing && existingStatus !== 'REJECTED') {
      return res.status(400).json({
        success: false,
        message: 'Review already submitted for this product'
      });
    }

    let writeRes;
    if (existing && existingStatus === 'REJECTED') {
      writeRes = await supabase
        .from('participant_reviews')
        .update({
          review_text: String(reviewText || '').trim(),
          review_url: String(reviewUrl || '').trim(),
          status: 'PENDING'
        })
        .eq('id', existing.id)
        .select()
        .maybeSingle();
    } else {
      writeRes = await supabase
        .from('participant_reviews')
        .insert({
          allocation_id: allocationId,
          participant_id: participantId,
          product_id: productId || null,
          project_id: allocation.project_id,
          review_text: String(reviewText || '').trim(),
          review_url: String(reviewUrl || '').trim(),
          status: 'PENDING'
        })
        .select()
        .maybeSingle();

      // ── Handle schema fallback (product_id column missing) ──────────────────
      if (writeRes.error && isMissingSchemaObjectError(writeRes.error)) {
        // Schema doesn't have product_id column — try insert without it.
        const fallbackInsert = await supabase
          .from('participant_reviews')
          .insert({
            allocation_id: allocationId,
            participant_id: participantId,
            project_id: allocation.project_id,
            review_text: String(reviewText || '').trim(),
            review_url: String(reviewUrl || '').trim(),
            status: 'PENDING'
          });

        if (fallbackInsert.error) {
          // If the old schema has a unique constraint on (allocation_id, participant_id)
          // and this participant already has a row (e.g. for their first product),
          // UPDATE that row rather than INSERT a new one.
          if (isUniqueConstraintError(fallbackInsert.error)) {
            const upsertRes = await supabase
              .from('participant_reviews')
              .update({
                review_text: String(reviewText || '').trim(),
                review_url: String(reviewUrl || '').trim(),
                status: 'PENDING'
              })
              .eq('allocation_id', allocationId)
              .eq('participant_id', participantId)
              .select()
              .maybeSingle();
            writeRes = upsertRes;
          } else if (!isMissingSchemaObjectError(fallbackInsert.error)) {
            writeRes = { data: null, error: fallbackInsert.error };
          }
        } else {
          // Insert succeeded — fetch back the row
          const fetchBack = await supabase
            .from('participant_reviews')
            .select()
            .eq('allocation_id', allocationId)
            .eq('participant_id', participantId)
            .eq('status', 'PENDING')
            .limit(1)
            .maybeSingle();
          writeRes = fetchBack;
        }
      }

      // ── Handle unique constraint on (allocation_id, participant_id, product_id) ──
      // This happens when the DB constraint doesn't yet include product_id as a
      // separate column, causing a duplicate key error for the second product.
      if (writeRes.error && isUniqueConstraintError(writeRes.error)) {
        // The row already exists — this is effectively "already submitted".
        // Fetch the existing row and return it as success so the UI advances.
        const fetchExisting = await supabase
          .from('participant_reviews')
          .select()
          .eq('allocation_id', allocationId)
          .eq('participant_id', participantId)
          .limit(1)
          .maybeSingle();
        if (!fetchExisting.error && fetchExisting.data) {
          writeRes = { data: fetchExisting.data, error: null };
        } else {
          // Cannot recover — surface a friendly message instead of raw DB error
          return res.status(400).json({
            success: false,
            message: 'Review already submitted for this product'
          });
        }
      }
    }

    if (writeRes.error) throw writeRes.error;
    const data = writeRes.data;

    res.status(201).json({
      success: true,
      message: 'Review submitted and awaiting admin approval',
      data
    });
  } catch (err) {
    next(err);
  }
};

const getPendingReviews = async (req, res, next) => {
  try {
    const { data, error } = await fetchReviewRows((fields) =>
      supabase
        .from('participant_reviews')
        .select(fields)
        .eq('status', 'PENDING')
        .order('created_at', { ascending: true })
    );

    if (error) throw error;

    const enriched = await enrichReviewRows(data || []);
    res.json({
      success: true,
      data: enriched
    });
  } catch (err) {
    next(err);
  }
};

const getReviews = async (req, res, next) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 100;

    const { data, error } = await fetchReviewRows((fields) => {
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
    res.json({
      success: true,
      data: enriched
    });
  } catch (err) {
    next(err);
  }
};

const approveReview = async (req, res, next) => {
  try {
    const { id } = req.params;

    let reviewUpdateRes = await supabase
      .from('participant_reviews')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, allocation_id, participant_id, project_id, product_id')
      .maybeSingle();

    if (reviewUpdateRes.error && /product_id/i.test(String(reviewUpdateRes.error.message || ''))) {
      reviewUpdateRes = await supabase
        .from('participant_reviews')
        .update({ status: 'APPROVED' })
        .eq('id', id)
        .eq('status', 'PENDING')
        .select('id, allocation_id, participant_id, project_id')
        .maybeSingle();
    }

    const { data: review, error } = reviewUpdateRes;

    if (error) throw error;
    let reviewRow = review;
    let alreadyProcessed = false;

    if (!reviewRow) {
      let existingReviewRes = await supabase
        .from('participant_reviews')
        .select('id, allocation_id, participant_id, project_id, product_id, status')
        .eq('id', id)
        .maybeSingle();
      if (existingReviewRes.error && /product_id/i.test(String(existingReviewRes.error.message || ''))) {
        existingReviewRes = await supabase
          .from('participant_reviews')
          .select('id, allocation_id, participant_id, project_id, status')
          .eq('id', id)
          .maybeSingle();
      }
      const { data: existingReview, error: existingReviewError } = existingReviewRes;
      if (existingReviewError) throw existingReviewError;
      if (!existingReview) {
        return res.status(404).json({
          success: false,
          message: 'Review not found'
        });
      }
      reviewRow = existingReview;
      alreadyProcessed = String(existingReview.status || '').toUpperCase() === 'APPROVED';
    }

    // Resolve the correct project_id via the participant's application for this product.
    // reviewRow.project_id can be allocation-derived in multi-brand allocations.
    let resolvedProjectId = reviewRow.project_id || null;
    if (reviewRow.participant_id && reviewRow.product_id) {
      const { data: appForProduct, error: appForProductError } = await supabase
        .from('project_applications')
        .select('project_id, created_at')
        .eq('participant_id', reviewRow.participant_id)
        .eq('product_id', reviewRow.product_id)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (appForProductError) {
        console.warn('[approveReview] Could not resolve project_id via project_applications:', appForProductError.message || appForProductError);
      } else if (appForProduct?.project_id) {
        resolvedProjectId = appForProduct.project_id;
      }
    }

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('reward, mode')
      .eq('id', resolvedProjectId)
      .maybeSingle();
    if (!projectError) {
      try {
        await ensureEligiblePayout({
          participantId: reviewRow.participant_id,
          projectId: resolvedProjectId,
          fallbackReward: project?.reward
        });
      } catch (sideEffectError) {
        console.error('approveReview ensureEligiblePayout warning:', sideEffectError);
      }
    }

    // D2C: when the second artifact (review) is approved, attempt to create the per-product payout.
    if (reviewRow.product_id && resolvedProjectId) {
      try {
        const payoutId = await createPayoutIfBothApproved({
          participantId: reviewRow.participant_id,
          projectId: resolvedProjectId,
          productId: reviewRow.product_id,
          allocationId: reviewRow.allocation_id
        });
        if (payoutId) console.log(`[approveReview] Payout created: ${payoutId}`);
      } catch (payoutSideEffectError) {
        console.error('approveReview createPayoutIfBothApproved warning:', payoutSideEffectError);
      }
    }

    // Only mark completed when the full submission requirements are met.
    // - MARKETPLACE: review-only flow
    // - D2C/default: BOTH invoice (purchase proof) and review must be approved
    const mode = String(project?.mode || '').toUpperCase();
    let canComplete = mode === 'MARKETPLACE';

    if (!canComplete) {
      try {
        let proofRes = null;

        if (reviewRow.product_id) {
          proofRes = await supabase
            .from('purchase_proofs')
            .select('id')
            .eq('allocation_id', reviewRow.allocation_id)
            .eq('participant_id', reviewRow.participant_id)
            .eq('product_id', reviewRow.product_id)
            .eq('status', 'APPROVED')
            .limit(1);

          if (proofRes.error && isMissingSchemaObjectError(proofRes.error)) {
            proofRes = null;
          }
        }

        if (!proofRes) {
          proofRes = await supabase
            .from('purchase_proofs')
            .select('id')
            .eq('allocation_id', reviewRow.allocation_id)
            .eq('participant_id', reviewRow.participant_id)
            .eq('status', 'APPROVED')
            .limit(1);
        }

        if (proofRes.error && !isMissingSchemaObjectError(proofRes.error)) {
          throw proofRes.error;
        }

        canComplete = Array.isArray(proofRes.data)
          ? proofRes.data.length > 0
          : Boolean(proofRes.data?.id);
      } catch (proofLookupError) {
        console.error('approveReview proof lookup warning:', proofLookupError);
        canComplete = false;
      }
    }

    if (canComplete) {
      try {
        await markAllocationCompleted({
          allocationId: reviewRow.allocation_id,
          participantId: reviewRow.participant_id
        });
      } catch (allocationError) {
        console.error('approveReview markAllocationCompleted warning:', allocationError);
      }

      try {
        await markApplicationCompleted({
          participantId: reviewRow.participant_id,
          projectId: resolvedProjectId,
          productId: reviewRow.product_id || null
        });
      } catch (applicationError) {
        console.error('approveReview markApplicationCompleted warning:', applicationError);
      }
    }

    res.json({
      success: true,
      message: alreadyProcessed
        ? 'Review already approved'
        : 'Review approved and payout eligibility created'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('id', reviewRow.participant_id)
      .maybeSingle();

    const { data: reviewProject } = reviewRow.project_id
      ? await supabase.from('projects').select('title, name').eq('id', reviewRow.project_id).maybeSingle()
      : { data: null };
    const reviewProjectName = reviewProject?.title || reviewProject?.name || null;
    const approvedProducts = reviewRow.project_id
      ? await getApprovedProductsForParticipantProject(reviewRow.participant_id, reviewRow.project_id)
      : [];

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '🎊 Review Approved — Your Payout Is Unlocked!',
        html: reviewApprovedEmail(participant.full_name, reviewProjectName, null, approvedProducts)
      });
    }
  } catch (err) {
    next(err);
  }
};

const rejectReview = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('participant_reviews')
      .update({ status: 'REJECTED' })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, participant_id, project_id')
      .maybeSingle();

    if (error) throw error;
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

    const { data: rejProject } = data.project_id
      ? await supabase.from('projects').select('title, name').eq('id', data.project_id).maybeSingle()
      : { data: null };
    const rejProjectName = rejProject?.title || rejProject?.name || null;

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: '📝 Your Review Needs Revision',
        html: reviewRejectedEmail(participant.full_name, rejProjectName)
      });
    }
  } catch (err) {
    next(err);
  }
};

module.exports = {
  submitFeedback,
  submitReview,
  getReviews,
  getPendingReviews,
  approveReview,
  rejectReview
};
