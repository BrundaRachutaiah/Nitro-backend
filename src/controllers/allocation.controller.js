const supabase = require('../config/supabaseClient');
const env = require('../config/env');
const { ALLOCATION_STATUS, PROOF_STATUS } = require('../utils/constants');
const { sendEmail } = require('../services/email.service');
const { allocationEmail, allocationCancelledParticipantEmail, adminAllocationCancelledEmail } = require('../services/email.templates');
const frontendUrl = String(env.frontendUrl || 'http://localhost:5173').replace(/\/$/, '');

const RESERVATION_DAYS = 20;

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

const buildAllocationProductKey = (allocationId, productId) =>
  `${allocationId}::${productId || '__allocation__'}`;

/**
 * Allocate unit for an application (Admin)
 */
const allocateUnit = async (req, res, next) => {
  try {
    const { applicationId } = req.params;

    const { data: application } = await supabase
      .from('project_applications')
      .select('id, project_id, participant_id')
      .eq('id', applicationId)
      .maybeSingle();

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    const { data: existingAllocation } = await supabase
      .from('unit_allocations')
      .select('id')
      .eq('project_id', application.project_id)
      .eq('participant_id', application.participant_id)
      .maybeSingle();

    if (existingAllocation) {
      return res.status(400).json({
        success: false,
        message: 'Unit already allocated for this participant'
      });
    }

    const { data: project } = await supabase
      .from('projects')
      .select('total_units')
      .eq('id', application.project_id)
      .maybeSingle();

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const { count } = await supabase
      .from('unit_allocations')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', application.project_id)
      .eq('status', ALLOCATION_STATUS.RESERVED);

    if (count >= project.total_units) {
      return res.status(400).json({
        success: false,
        message: 'All units are already allocated'
      });
    }

    const reservedUntil = new Date();
    reservedUntil.setDate(reservedUntil.getDate() + RESERVATION_DAYS);

    const { data, error } = await supabase
      .from('unit_allocations')
      .insert({
        project_id: application.project_id,
        participant_id: application.participant_id,
        reserved_until: reservedUntil.toISOString(),
        status: ALLOCATION_STATUS.RESERVED
      })
      .select()
      .single();

    if (error) throw error;

    await supabase
      .from('project_applications')
      .update({
        status: 'APPROVED',
        allocation_id: data.id,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', applicationId)
      .eq('participant_id', application.participant_id);

    res.status(201).json({
      success: true,
      message: 'Unit allocated and reserved for 20 days',
      data
    });

    const [{ data: participant }, { data: projectInfo }] = await Promise.all([
      supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', application.participant_id)
        .maybeSingle(),
      supabase
        .from('projects')
        .select('title, name')
        .eq('id', application.project_id)
        .maybeSingle()
    ]);

    if (participant?.email) {
      const projectName = projectInfo?.title || projectInfo?.name || 'your project';

      const { data: allocProducts } = application.product_id
        ? await supabase
            .from('project_products')
            .select('id, name, product_url, image_url, product_value')
            .eq('id', application.product_id)
        : await supabase
            .from('project_products')
            .select('id, name, product_url, image_url, product_value')
            .eq('project_id', application.project_id)
            .limit(3);

      sendEmail({
        to: participant.email,
        subject: `🛒 Unit Reserved — ${projectName}`,
        html: allocationEmail(
          participant.full_name,
          projectName,
          reservedUntil,
          allocProducts || []
        )
      });
    }
  } catch (err) {
    next(err);
  }
};

/**
 * Get my allocations (Participant)
 */
const getMyAllocations = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        status,
        reserved_until,
        projects (
          id,
          name,
          mode
        )
      `
      )
      .eq('participant_id', participantId);

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

/**
 * Get my allocation tracking (Participant)
 */
const getMyAllocationTracking = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    let { data: allocations, error: allocationError } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        project_id,
        status,
        reserved_until,
        created_at,
        projects (
          id,
          title,
          name,
          mode,
          reward
        )
      `
      )
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });

    if (allocationError && /unit_allocations\.created_at/i.test(String(allocationError.message || ''))) {
      const fallbackAllocations = await supabase
        .from('unit_allocations')
        .select(
          `
          id,
          project_id,
          status,
          reserved_until,
          projects (
            id,
            title,
            name,
            mode,
            reward
          )
        `
        )
        .eq('participant_id', participantId)
        .order('reserved_until', { ascending: false });

      allocations = fallbackAllocations.data || [];
      allocationError = fallbackAllocations.error || null;
    }

    if (allocationError) throw allocationError;

    // Self-heal legacy state: if participant has APPROVED products but no active
    // allocation (often after older cancellation flows), create one RESERVED slot
    // per project so My Tasks can show all approved products in one flow.
    if (!allocations || allocations.length === 0) {
      const approvedAppsRes = await supabase
        .from('project_applications')
        .select('id, project_id, participant_id, status')
        .eq('participant_id', participantId)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED']);

      if (approvedAppsRes.error && !isMissingSchemaObjectError(approvedAppsRes.error)) {
        throw approvedAppsRes.error;
      }

      const approvedApps = approvedAppsRes.data || [];
      const approvedProjectIds = [...new Set(approvedApps.map((row) => row.project_id).filter(Boolean))];

      if (approvedProjectIds.length) {
        const existingActiveAllocRes = await supabase
          .from('unit_allocations')
          .select('id, project_id, status')
          .eq('participant_id', participantId)
          .in('project_id', approvedProjectIds)
          .in('status', [ALLOCATION_STATUS.RESERVED, ALLOCATION_STATUS.PURCHASED]);

        if (existingActiveAllocRes.error && !isMissingSchemaObjectError(existingActiveAllocRes.error)) {
          throw existingActiveAllocRes.error;
        }

        const activeProjectIds = new Set((existingActiveAllocRes.data || []).map((row) => row.project_id));
        const toCreateProjectIds = approvedProjectIds.filter((projectId) => !activeProjectIds.has(projectId));

        if (toCreateProjectIds.length) {
          const reservedUntil = new Date();
          reservedUntil.setDate(reservedUntil.getDate() + RESERVATION_DAYS);
          const rowsToInsert = toCreateProjectIds.map((projectId) => ({
            project_id: projectId,
            participant_id: participantId,
            reserved_until: reservedUntil.toISOString(),
            status: ALLOCATION_STATUS.RESERVED
          }));
          const { error: createAllocError } = await supabase
            .from('unit_allocations')
            .insert(rowsToInsert);
          if (createAllocError && !isMissingSchemaObjectError(createAllocError)) {
            throw createAllocError;
          }
        }

        let refreshedAllocationsRes = await supabase
          .from('unit_allocations')
          .select(
            `
            id,
            project_id,
            status,
            reserved_until,
            created_at,
            projects (
              id,
              title,
              name,
              mode,
              reward
            )
          `
          )
          .eq('participant_id', participantId)
          .order('created_at', { ascending: false });

        if (refreshedAllocationsRes.error && /unit_allocations\.created_at/i.test(String(refreshedAllocationsRes.error.message || ''))) {
          refreshedAllocationsRes = await supabase
            .from('unit_allocations')
            .select(
              `
              id,
              project_id,
              status,
              reserved_until,
              projects (
                id,
                title,
                name,
                mode,
                reward
              )
            `
            )
            .eq('participant_id', participantId)
            .order('reserved_until', { ascending: false });
        }

        if (refreshedAllocationsRes.error) throw refreshedAllocationsRes.error;
        allocations = refreshedAllocationsRes.data || [];
      }
    }

    if (!allocations || allocations.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const allocationIds = allocations.map((item) => item.id);

    const activeAllocationIds = allocations
      .filter(a => ['RESERVED', 'PURCHASED'].includes(String(a.status || '').toUpperCase()))
      .map(a => a.id);

    // Collect all project_ids from active allocations for fallback matching
    // when application rows have allocation_id = NULL
    const activeProjectIds = allocations
      .filter(a => ['RESERVED', 'PURCHASED'].includes(String(a.status || '').toUpperCase()))
      .map(a => a.project_id)
      .filter(Boolean);

    const [proofsRes, reviewsRes, feedbacksRes, payoutsRes, applicationsRes] = await Promise.all([
      supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, product_id, status, file_url, uploaded_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('uploaded_at', { ascending: false }),
      supabase
        .from('participant_reviews')
        .select('id, allocation_id, participant_id, product_id, review_text, review_url, status, created_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('internal_feedbacks')
        .select('id, allocation_id, participant_id, product_id, rating, created_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('payouts')
        .select('id, project_id, product_id, purchase_proof_id, amount, status, created_at')
        .eq('participant_id', participantId)
        .order('created_at', { ascending: false }),
      // ── FIX: Fetch applications WITHOUT filtering by allocation_id ──────────
      // Previously .in('allocation_id', activeAllocationIds) silently dropped every
      // application whose allocation_id was NULL (legacy rows / backfill gap),
      // making selected_products appear empty. Now we fetch all approved apps by
      // participant_id + status and join to allocations in memory.
      supabase
        .from('project_applications')
        .select(
          `
          id,
          project_id,
          product_id,
          allocation_id,
          allocated_budget,
          status,
          reviewed_at,
          created_at,
          projects (
            id,
            title,
            name,
            mode
          ),
          project_products (
            id,
            name,
            product_value,
            product_url
          )
        `
        )
        .eq('participant_id', participantId)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('created_at', { ascending: false })
    ]);

    let proofRows = (proofsRes.data || []).map((item) => ({
      ...item,
      created_at: item.created_at || item.uploaded_at || null
    }));
    if (proofsRes.error) {
      if (!isMissingSchemaObjectError(proofsRes.error)) throw proofsRes.error;

      let fallbackProofs = await supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, product_id, status, file_url, uploaded_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('uploaded_at', { ascending: false });

      if (fallbackProofs.error && isMissingSchemaObjectError(fallbackProofs.error)) {
        fallbackProofs = await supabase
          .from('purchase_proofs')
          .select('id, allocation_id, participant_id, status, file_url, uploaded_at')
          .eq('participant_id', participantId)
          .in('allocation_id', allocationIds)
          .order('uploaded_at', { ascending: false });
      }

      if (fallbackProofs.error && !isMissingSchemaObjectError(fallbackProofs.error)) {
        throw fallbackProofs.error;
      }

      proofRows = (fallbackProofs.data || []).map((item) => ({
        ...item,
        created_at: item.created_at || item.uploaded_at || null,
        file_url: item.file_url || null
      }));
    }

    let reviewRows = reviewsRes.data || [];
    if (reviewsRes.error) {
      if (!isMissingSchemaObjectError(reviewsRes.error)) throw reviewsRes.error;

      const fallbackReviews = await supabase
        .from('participant_reviews')
        .select('id, allocation_id, participant_id, review_url, status, created_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('created_at', { ascending: false });

      if (fallbackReviews.error && !isMissingSchemaObjectError(fallbackReviews.error)) {
        throw fallbackReviews.error;
      }

      reviewRows = (fallbackReviews.data || []).map((item) => ({
        ...item,
        review_text: item?.review_text || null
      }));
    }

    const feedbackRows = feedbacksRes.error
      ? (isMissingSchemaObjectError(feedbacksRes.error) ? [] : (() => { throw feedbacksRes.error; })())
      : (feedbacksRes.data || []);

    let payoutRows = payoutsRes.data || [];
    if (payoutsRes.error) {
      if (!isMissingSchemaObjectError(payoutsRes.error)) throw payoutsRes.error;

      const fallbackPayouts = await supabase
        .from('payouts')
        .select('id, project_id, amount, status, created_at')
        .eq('participant_id', participantId)
        .order('created_at', { ascending: false });

      if (fallbackPayouts.error && !isMissingSchemaObjectError(fallbackPayouts.error)) {
        throw fallbackPayouts.error;
      }

      payoutRows = (fallbackPayouts.data || []).map((item) => ({
        ...item,
        purchase_proof_id: null,
        product_id: null
      }));
    }

    let approvedApplications = applicationsRes.data || [];
    if (applicationsRes.error) {
      if (!isMissingSchemaObjectError(applicationsRes.error)) throw applicationsRes.error;

      // Fallback: fetch approved apps for this participant (across ALL projects).
      // NOTE: Do NOT filter by allocation_id — rows with allocation_id = NULL
      // would be silently dropped, making the task list appear empty.
      const fallbackApps = await supabase
        .from('project_applications')
        .select('id, project_id, product_id, allocation_id, allocated_budget, status, reviewed_at, created_at')
        .eq('participant_id', participantId)
        .in('status', ['APPROVED', 'PURCHASED', 'COMPLETED'])
        .order('created_at', { ascending: false });

      if (fallbackApps.error && !isMissingSchemaObjectError(fallbackApps.error)) {
        throw fallbackApps.error;
      }

      approvedApplications = (fallbackApps.data || []).map((item) => ({
        ...item,
        project_products: null
      }));
    }

    // Fallback: if relational select does not hydrate product details, fetch by product_id.
    const missingProductDetails = approvedApplications
      .some((item) => item?.product_id && !item?.project_products);
    if (missingProductDetails) {
      const productIds = [...new Set(
        approvedApplications.map((item) => item?.product_id).filter(Boolean)
      )];

      let productMap = new Map();
      if (productIds.length) {
        const { data: productRows, error: productError } = await supabase
          .from('project_products')
          .select('id, name, product_value, product_url')
          .in('id', productIds);

        if (productError && !isMissingSchemaObjectError(productError)) {
          throw productError;
        }

        productMap = new Map((productRows || []).map((row) => [row.id, row]));
      }

      approvedApplications = approvedApplications.map((item) => ({
        ...item,
        project_products: item?.project_products || productMap.get(item?.product_id) || null
      }));
    }

    const proofsByAllocation = new Map();
    const proofsByAllocationProduct = new Map();
    const proofsByProduct = new Map();
    for (const item of proofRows) {
      const pairKey = buildAllocationProductKey(item.allocation_id, item.product_id);
      if (!proofsByAllocationProduct.has(pairKey)) {
        proofsByAllocationProduct.set(pairKey, item);
      }
      if (!proofsByAllocation.has(item.allocation_id)) {
        proofsByAllocation.set(item.allocation_id, item);
      }
      if (item.product_id && !proofsByProduct.has(item.product_id)) {
        proofsByProduct.set(item.product_id, item);
      }
    }

    const reviewsByAllocation = new Map();
    const reviewsByAllocationProduct = new Map();
    const reviewsByProduct = new Map();
    for (const item of reviewRows) {
      const pairKey = buildAllocationProductKey(item.allocation_id, item.product_id);
      if (!reviewsByAllocationProduct.has(pairKey)) {
        reviewsByAllocationProduct.set(pairKey, item);
      }
      if (!reviewsByAllocation.has(item.allocation_id)) {
        reviewsByAllocation.set(item.allocation_id, item);
      }
      if (item.product_id && !reviewsByProduct.has(item.product_id)) {
        reviewsByProduct.set(item.product_id, item);
      }
    }

    const feedbacksByAllocation = new Map();
    const feedbacksByAllocationProduct = new Map();
    const feedbacksByProduct = new Map();
    for (const item of feedbackRows) {
      const pairKey = buildAllocationProductKey(item.allocation_id, item.product_id);
      if (!feedbacksByAllocationProduct.has(pairKey)) {
        feedbacksByAllocationProduct.set(pairKey, item);
      }
      if (!feedbacksByAllocation.has(item.allocation_id)) {
        feedbacksByAllocation.set(item.allocation_id, item);
      }
      if (item.product_id && !feedbacksByProduct.has(item.product_id)) {
        feedbacksByProduct.set(item.product_id, item);
      }
    }

    const payoutsByProofId = new Map();
    const payoutsByProjectId = new Map();
    const payoutsByProjectProduct = new Map();
    for (const item of payoutRows) {
      if (item.purchase_proof_id && !payoutsByProofId.has(item.purchase_proof_id)) {
        payoutsByProofId.set(item.purchase_proof_id, item);
      }

      if (item.project_id && item.product_id) {
        const key = `${item.project_id}::${item.product_id}`;
        if (!payoutsByProjectProduct.has(key)) payoutsByProjectProduct.set(key, item);
      }

      if (item.project_id && !payoutsByProjectId.has(item.project_id)) {
        payoutsByProjectId.set(item.project_id, item);
      }
    }

    const rows = allocations.map((allocation) => {
      // ── FIX: Two-step match ──────────────────────────────────────────────────
      // 1. If allocation_id is set on the app → exact match (preferred)
      // 2. If allocation_id is NULL → fall back to project_id match
      // This ensures legacy rows without allocation_id are never silently dropped.
      const approvedForProject = approvedApplications.filter((app) => {
        if (app.allocation_id) return app.allocation_id === allocation.id;
        return app.project_id === allocation.project_id;
      });

      // ── FIX: Deduplicate by product_id — prefer APPROVED > PURCHASED > COMPLETED
      // This ensures a new cycle APPROVED app shows instead of the old COMPLETED one
      // when a participant re-applies for the same product in a new cycle.
      const STATUS_PRIORITY = { 'APPROVED': 3, 'PURCHASED': 2, 'COMPLETED': 1 };
      const latestByProduct = new Map();
      for (const item of approvedForProject) {
        const productKey = String(item?.product_id || '');
        if (!productKey) continue;
        const existing = latestByProduct.get(productKey);
        if (!existing) {
          latestByProduct.set(productKey, item);
          continue;
        }
        const newPriority = STATUS_PRIORITY[String(item?.status || '').toUpperCase()] || 0;
        const oldPriority = STATUS_PRIORITY[String(existing?.status || '').toUpperCase()] || 0;
        // Prefer higher priority status (APPROVED wins over COMPLETED)
        if (newPriority > oldPriority) {
          latestByProduct.set(productKey, item);
          continue;
        }
        // Same priority — prefer newer created_at
        if (newPriority === oldPriority) {
          const nextTime = new Date(item?.created_at || 0).getTime();
          const existingTime = new Date(existing?.created_at || 0).getTime();
          if (nextTime > existingTime) latestByProduct.set(productKey, item);
        }
      }
      const approvedProducts = latestByProduct.size
        ? Array.from(latestByProduct.values())
        : approvedForProject;

      const proof = proofsByAllocation.get(allocation.id) || null;
      const review = reviewsByAllocation.get(allocation.id) || null;
      const feedback = feedbacksByAllocation.get(allocation.id) || null;
      const payout = (proof?.id && payoutsByProofId.get(proof.id))
        || payoutsByProjectId.get(allocation.project_id)
        || null;

      const selectedProducts = approvedProducts.map((item) => ({
        ...(item || {}),
        application_id: item?.id || null,
        product_id: item?.product_id || null,
        product_name: item?.project_products?.name || null,
        product_url: item?.project_products?.product_url || null,
        product_value: Number(item?.project_products?.product_value || 0),
        project_title: item?.projects?.title || item?.projects?.name || null,
        project_mode: String(item?.projects?.mode || allocation?.projects?.mode || '').toUpperCase() || null,
        application_status: String(item?.status || '').toUpperCase(),
        purchase_proof:
          proofsByAllocationProduct.get(buildAllocationProductKey(allocation.id, item?.product_id))
          || proofsByProduct.get(item?.product_id)
          || null,
        review_submission:
          reviewsByAllocationProduct.get(buildAllocationProductKey(allocation.id, item?.product_id))
          || reviewsByProduct.get(item?.product_id)
          || null,
        feedback_submission:
          feedbacksByAllocationProduct.get(buildAllocationProductKey(allocation.id, item?.product_id))
          || feedbacksByProduct.get(item?.product_id)
          || null,
        payout:
          (item?.project_id && item?.product_id
            ? payoutsByProjectProduct.get(`${item.project_id}::${item.product_id}`)
            : null)
          || null
      }));

      // Compatibility fallback: if DB stores proof/review at allocation-level (no product_id),
      // attach those records to the single product so participant can continue the flow.
      if (selectedProducts.length === 1) {
        if (!selectedProducts[0].purchase_proof && proof) selectedProducts[0].purchase_proof = proof;
        if (!selectedProducts[0].review_submission && review) selectedProducts[0].review_submission = review;
        if (!selectedProducts[0].feedback_submission && feedback) selectedProducts[0].feedback_submission = feedback;
      }

      return {
        ...allocation,
        selected_product: approvedProducts[0]?.project_products || null,
        selected_products: selectedProducts,
        purchase_proof: proof,
        review_submission: review,
        feedback_submission: feedback,
        payout
      };
    });

    res.json({
      success: true,
      data: rows
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get active allocations
 */
const getActiveAllocations = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        reserved_until,
        created_at,
        projects (
          id,
          title,
          reward
        )
      `
      )
      .eq('participant_id', participantId)
      .in('status', ['RESERVED', 'PURCHASED'])
      .order('reserved_until', { ascending: true });

    if (error && /completed_at/i.test(String(error.message || ''))) {
      const fallback = await supabase
        .from('unit_allocations')
        .select(`
          id,
          reserved_until,
          created_at,
          projects (
            id,
            title,
            reward
          )
        `)
        .eq('participant_id', participantId)
        .in('status', ['RESERVED', 'PURCHASED'])
        .order('reserved_until', { ascending: true });

      if (fallback.error) throw fallback.error;
      return res.json({ success: true, data: fallback.data });
    }

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get allocation by ID
 */
const getAllocationById = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id } = req.params;

    const { data: allocation, error } = await supabase
      .from('unit_allocations')
      .select(
        `
        id,
        reserved_until,
        created_at,
        projects (
          id,
          title,
          description,
          reward
        )
      `
      )
      .eq('id', id)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) throw error;

    if (!allocation) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found'
      });
    }

    const { data: proof } = await supabase
      .from('purchase_proofs')
      .select('id, status, created_at')
      .eq('allocation_id', allocation.id)
      .eq('participant_id', participantId)
      .maybeSingle();

    let nextAction = 'NONE';

    if (!proof) {
      nextAction = 'UPLOAD_PURCHASE_PROOF';
    } else if (proof.status === PROOF_STATUS.REJECTED) {
      nextAction = 'REUPLOAD_PURCHASE_PROOF';
    } else if (proof.status === PROOF_STATUS.APPROVED) {
      nextAction = 'WAIT_FOR_PAYOUT';
    }

    res.json({
      success: true,
      data: {
        allocation,
        purchase_proof: proof || null,
        next_action: nextAction
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Update allocation status
 */
const updateAllocationStatus = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id } = req.params;
    const { status } = req.body;

    if (![ALLOCATION_STATUS.PURCHASED, ALLOCATION_STATUS.COMPLETED].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status transition'
      });
    }

    let data;
    let error;

    if (status === ALLOCATION_STATUS.PURCHASED) {
      let res = await supabase
        .from('unit_allocations')
        .update({ status: ALLOCATION_STATUS.PURCHASED })
        .eq('id', id)
        .eq('participant_id', participantId)
        .is('completed_at', null)
        .select()
        .maybeSingle();

      if (res.error && /completed_at/i.test(String(res.error.message || ''))) {
        res = await supabase
          .from('unit_allocations')
          .update({ status: ALLOCATION_STATUS.PURCHASED })
          .eq('id', id)
          .eq('participant_id', participantId)
          .neq('status', ALLOCATION_STATUS.COMPLETED)
          .select()
          .maybeSingle();
      }

      if (res.error && /status.*column|column.*status/i.test(String(res.error.message || ''))) {
        res = await supabase
          .from('unit_allocations')
          .update({ status: ALLOCATION_STATUS.PURCHASED })
          .eq('id', id)
          .eq('participant_id', participantId)
          .select()
          .maybeSingle();
      }

      data = res.data;
      error = res.error;
    } else {
      const completedPayload = { status: ALLOCATION_STATUS.COMPLETED };
      let res = await supabase
        .from('unit_allocations')
        .update({ ...completedPayload, completed_at: new Date().toISOString() })
        .eq('id', id)
        .eq('participant_id', participantId)
        .is('completed_at', null)
        .select()
        .maybeSingle();

      if (res.error && /completed_at/i.test(String(res.error.message || ''))) {
        res = await supabase
          .from('unit_allocations')
          .update(completedPayload)
          .eq('id', id)
          .eq('participant_id', participantId)
          .select()
          .maybeSingle();
      }

      data = res.data;
      error = res.error;
    }

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message: 'Allocation not found or already processed'
      });
    }

    res.json({
      success: true,
      message: status === ALLOCATION_STATUS.PURCHASED
        ? 'Allocation marked as purchased'
        : 'Allocation marked as completed',
      data
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// cancelAllocation
// ─────────────────────────────────────────────────────────────────────────────
const cancelAllocation = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { id: allocationId } = req.params;

    const { data: allocation, error: allocError } = await supabase
      .from('unit_allocations')
      .select('id, project_id, status, participant_id')
      .eq('id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (allocError || !allocation) {
      return res.status(404).json({ success: false, message: 'Allocation not found.' });
    }

    const currentStatus = String(allocation.status || '').toUpperCase();
    if (!['RESERVED', 'PURCHASED'].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: `This allocation cannot be cancelled — current status is ${currentStatus}.`
      });
    }

    const { error: cancelError } = await supabase
      .from('unit_allocations')
      .update({ status: 'CANCELLED' })
      .eq('id', allocationId)
      .eq('participant_id', participantId);

    if (cancelError) throw cancelError;

    res.json({
      success: true,
      message: 'Allocation cancelled successfully. Your reserved slot has been released.',
      data: { allocationId }
    });

    let restoredAmt = 0;
    let products    = [];
    let projectName = 'your project';
    let participantProfile = null;

    try {
      const nowIso = new Date().toISOString();

      let rejectedApps = null;
      let appRes = await supabase
        .from('project_applications')
        .update({
          status:            'REJECTED',
          reviewed_at:       nowIso,
          eligibility_notes: 'Automatically rejected — participant cancelled their reservation.'
        })
        .eq('participant_id', participantId)
        .in('status',         ['APPROVED', 'PURCHASED'])
        .select('id, product_id, allocated_budget');

      if (appRes.error && isMissingSchemaObjectError(appRes.error)) {
        appRes = await supabase
          .from('project_applications')
          .update({ status: 'REJECTED', reviewed_at: nowIso })
          .eq('participant_id', participantId)
          .in('status',         ['APPROVED', 'PURCHASED'])
          .select('id, product_id, allocated_budget');
      }

      rejectedApps = appRes.data || [];
      restoredAmt  = rejectedApps.reduce((s, a) => s + Number(a.allocated_budget || 0), 0);
      const productIds = [...new Set(rejectedApps.map((a) => a.product_id).filter(Boolean))];

      if (productIds.length) {
        const { data: productRows } = await supabase
          .from('project_products')
          .select('id, name, image_url, product_value')
          .in('id', productIds);

        const budgetMap = new Map(rejectedApps.map((a) => [a.product_id, a.allocated_budget]));
        products = (productRows || []).map((p) => ({
          name:          p.name,
          image_url:     p.image_url || null,
          product_value: budgetMap.get(p.id) ?? p.product_value ?? null
        }));
      }
    } catch (err) {
      console.error('[cancelAllocation] Budget restore failed (non-fatal):', err);
    }

    try {
      const [projectRes, profileRes] = await Promise.all([
        supabase.from('projects').select('id, title, name').eq('id', allocation.project_id).maybeSingle(),
        supabase.from('profiles').select('id, full_name, email').eq('id', participantId).maybeSingle()
      ]);
      projectName        = projectRes.data?.title || projectRes.data?.name || 'your project';
      participantProfile = profileRes.data || null;
    } catch (err) {
      console.error('[cancelAllocation] Profile/project fetch failed (non-fatal):', err);
    }

    try {
      await supabase.from('notifications').insert({
        user_id: participantId,
        type:    'PRODUCT_APPLICATION',
        title:   'Reservation cancelled',
        message: `Your reservation for ${projectName} has been cancelled and your slot released.`
      });
    } catch (err) {
      console.error('[cancelAllocation] Participant notification failed (non-fatal):', err);
    }

    try {
      if (participantProfile?.email) {
        sendEmail({
          to:      participantProfile.email,
          subject: `Reservation Cancelled — ${projectName}`,
          html:    allocationCancelledParticipantEmail({
            name:        participantProfile.full_name || 'Participant',
            projectName,
            products,
            browseUrl:   `${frontendUrl}/projects`
          })
        });
      }
    } catch (err) {
      console.error('[cancelAllocation] Participant email failed (non-fatal):', err);
    }

    try {
      const { data: adminProfiles } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('role', ['ADMIN', 'SUPER_ADMIN'])
        .eq('status', 'APPROVED');

      for (const admin of (adminProfiles || [])) {
        try {
          await supabase.from('notifications').insert({
            user_id: admin.id,
            type:    'PRODUCT_APPLICATION',
            title:   'Participant cancelled reservation',
            message: `${participantProfile?.full_name || 'A participant'} cancelled their slot for "${projectName}".${restoredAmt > 0 ? ` ₹${Number(restoredAmt).toLocaleString('en-IN')} restored.` : ''}`
          });

          if (admin.email) {
            sendEmail({
              to:      admin.email,
              subject: `🔔 Reservation Cancelled — ${projectName}`,
              html:    adminAllocationCancelledEmail({
                adminName:        admin.full_name || 'Admin',
                participantName:  participantProfile?.full_name || 'Participant',
                participantEmail: participantProfile?.email     || '',
                projectName,
                projectId:        allocation.project_id,
                products,
                restoredAmount:   restoredAmt,
                dashboardUrl:     `${frontendUrl}/admin/product-applications`
              })
            });
          }
        } catch (err) {
          console.error(`[cancelAllocation] Admin ${admin.id} notify failed (non-fatal):`, err);
        }
      }
    } catch (err) {
      console.error('[cancelAllocation] Admin notify block failed (non-fatal):', err);
    }

  } catch (err) {
    next(err);
  }
};

module.exports = {
  allocateUnit,
  getMyAllocations,
  getMyAllocationTracking,
  getActiveAllocations,
  getAllocationById,
  updateAllocationStatus,
  cancelAllocation
};