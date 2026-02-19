const supabase = require('../config/supabaseClient');
const { ALLOCATION_STATUS, PROOF_STATUS } = require('../utils/constants');
const { sendEmail } = require('../services/email.service');
const { allocationEmail } = require('../services/email.templates');

const RESERVATION_DAYS = 5;

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
        reviewed_at: new Date().toISOString()
      })
      .eq('id', applicationId)
      .eq('participant_id', application.participant_id);

    res.status(201).json({
      success: true,
      message: 'Unit allocated and reserved for 5 days',
      data
    });

    const [{ data: participant }, { data: projectInfo }] = await Promise.all([
      supabase
        .from('profiles')
        .select('email')
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
      sendEmail({
        to: participant.email,
        subject: 'Unit reserved for your Nitro project',
        html: allocationEmail(projectName, new Date(reservedUntil).toLocaleString())
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

    if (!allocations || allocations.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const allocationIds = allocations.map((item) => item.id);
    const projectIds = [...new Set(allocations.map((item) => item.project_id).filter(Boolean))];

    const [proofsRes, reviewsRes, feedbacksRes, payoutsRes, applicationsRes] = await Promise.all([
      supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, status, file_url, created_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('participant_reviews')
        .select('id, allocation_id, participant_id, review_url, status, created_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('internal_feedbacks')
        .select('id, allocation_id, participant_id, rating, created_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('created_at', { ascending: false }),
      projectIds.length
        ? supabase
            .from('payouts')
            .select('id, project_id, purchase_proof_id, amount, status, created_at')
            .eq('participant_id', participantId)
            .in('project_id', projectIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      projectIds.length
        ? supabase
            .from('project_applications')
            .select(
              `
              id,
              project_id,
              product_id,
              allocated_budget,
              status,
              project_products (
                id,
                name,
                product_value,
                product_url
              )
            `
            )
            .eq('participant_id', participantId)
            .in('project_id', projectIds)
            .eq('status', 'APPROVED')
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null })
    ]);

    let proofRows = proofsRes.data || [];
    if (proofsRes.error) {
      if (!isMissingSchemaObjectError(proofsRes.error)) throw proofsRes.error;

      // Some DBs use uploaded_at instead of created_at for purchase proofs.
      let fallbackProofs = await supabase
        .from('purchase_proofs')
        .select('id, allocation_id, participant_id, status, file_url, uploaded_at')
        .eq('participant_id', participantId)
        .in('allocation_id', allocationIds)
        .order('uploaded_at', { ascending: false });

      if (fallbackProofs.error && isMissingSchemaObjectError(fallbackProofs.error)) {
        fallbackProofs = await supabase
          .from('purchase_proofs')
          .select('id, allocation_id, participant_id, status, uploaded_at')
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

    const reviewRows = reviewsRes.error
      ? (isMissingSchemaObjectError(reviewsRes.error) ? [] : (() => { throw reviewsRes.error; })())
      : (reviewsRes.data || []);

    const feedbackRows = feedbacksRes.error
      ? (isMissingSchemaObjectError(feedbacksRes.error) ? [] : (() => { throw feedbacksRes.error; })())
      : (feedbacksRes.data || []);

    let payoutRows = payoutsRes.data || [];
    if (payoutsRes.error) {
      if (!isMissingSchemaObjectError(payoutsRes.error)) throw payoutsRes.error;

      if (projectIds.length) {
        const fallbackPayouts = await supabase
          .from('payouts')
          .select('id, project_id, amount, status, created_at')
          .eq('participant_id', participantId)
          .in('project_id', projectIds)
          .order('created_at', { ascending: false });

        if (fallbackPayouts.error && !isMissingSchemaObjectError(fallbackPayouts.error)) {
          throw fallbackPayouts.error;
        }

        payoutRows = (fallbackPayouts.data || []).map((item) => ({
          ...item,
          purchase_proof_id: null
        }));
      } else {
        payoutRows = [];
      }
    }

    let approvedApplications = applicationsRes.data || [];
    if (applicationsRes.error) {
      if (!isMissingSchemaObjectError(applicationsRes.error)) throw applicationsRes.error;

      const fallbackApps = projectIds.length
        ? await supabase
            .from('project_applications')
            .select('id, project_id, product_id, allocated_budget, status')
            .eq('participant_id', participantId)
            .in('project_id', projectIds)
            .eq('status', 'APPROVED')
            .order('created_at', { ascending: false })
        : { data: [], error: null };

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
    for (const item of proofRows) {
      if (!proofsByAllocation.has(item.allocation_id)) {
        proofsByAllocation.set(item.allocation_id, item);
      }
    }

    const reviewsByAllocation = new Map();
    for (const item of reviewRows) {
      if (!reviewsByAllocation.has(item.allocation_id)) {
        reviewsByAllocation.set(item.allocation_id, item);
      }
    }

    const feedbacksByAllocation = new Map();
    for (const item of feedbackRows) {
      if (!feedbacksByAllocation.has(item.allocation_id)) {
        feedbacksByAllocation.set(item.allocation_id, item);
      }
    }

    const payoutsByProofId = new Map();
    const payoutsByProjectId = new Map();
    for (const item of payoutRows) {
      if (item.purchase_proof_id && !payoutsByProofId.has(item.purchase_proof_id)) {
        payoutsByProofId.set(item.purchase_proof_id, item);
      }

      if (item.project_id && !payoutsByProjectId.has(item.project_id)) {
        payoutsByProjectId.set(item.project_id, item);
      }
    }

    const applicationByProjectId = new Map();
    for (const item of approvedApplications) {
      if (item.project_id && !applicationByProjectId.has(item.project_id)) {
        applicationByProjectId.set(item.project_id, item);
      }
    }

    const rows = allocations.map((allocation) => {
      const proof = proofsByAllocation.get(allocation.id) || null;
      const review = reviewsByAllocation.get(allocation.id) || null;
      const feedback = feedbacksByAllocation.get(allocation.id) || null;
      const payout = (proof?.id && payoutsByProofId.get(proof.id))
        || payoutsByProjectId.get(allocation.project_id)
        || null;
      const application = applicationByProjectId.get(allocation.project_id) || null;

      return {
        ...allocation,
        selected_product: application?.project_products || null,
        allocated_budget: Number(application?.allocated_budget || 0),
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
      .is('completed_at', null)
      .order('reserved_until', { ascending: true });

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
        completed_at,
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
      ({ data, error } = await supabase
        .from('unit_allocations')
        .update({ status: ALLOCATION_STATUS.PURCHASED })
        .eq('id', id)
        .eq('participant_id', participantId)
        .is('completed_at', null)
        .select()
        .maybeSingle());
    } else {
      ({ data, error } = await supabase
        .from('unit_allocations')
        .update({ completed_at: new Date().toISOString(), status: ALLOCATION_STATUS.COMPLETED })
        .eq('id', id)
        .eq('participant_id', participantId)
        .is('completed_at', null)
        .select()
        .maybeSingle());
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

module.exports = {
  allocateUnit,
  getMyAllocations,
  getMyAllocationTracking,
  getActiveAllocations,
  getAllocationById,
  updateAllocationStatus
};
