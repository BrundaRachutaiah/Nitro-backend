const supabase = require('../config/supabaseClient');
const { sendEmail } = require('../services/email.service');
const { calculatePayoutBreakdown } = require('../utils/payout.utils');
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
  const appMap = await getApprovedApplicationMap(participantIds, projectIds);
  const { data: profiles, error: profileError } = participantIds.length
    ? await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', participantIds)
    : { data: [], error: null };
  if (profileError) throw profileError;

  const profileMap = new Map((profiles || []).map((item) => [item.id, item]));

  return rows.map((row) => {
    const app = appMap.get(buildAppMapKey(row.participant_id, row.project_id)) || {};
    const profile = profileMap.get(row.participant_id) || {};
    return {
      ...row,
      project_name: projectMap.get(row.project_id) || null,
      product_id: app.product_id || null,
      product_name: app.product_name || null,
      participant_name: profile.full_name || null,
      participant_email: profile.email || null
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
  const { data, error } = await supabase
    .from('purchase_proofs')
    .select('id, status')
    .eq('allocation_id', allocationId)
    .eq('participant_id', participantId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) return null;
  return String(data?.status || '').toUpperCase() || 'PENDING';
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
    return getProofStatus(allocationId, participantId);
  }
  if (lookup.error) throw lookup.error;
  if (!lookup.data?.id) return null;
  return String(lookup.data?.status || '').toUpperCase() || 'PENDING';
};

const ensureEligiblePayout = async ({ participantId, projectId }) => {

  // 1️⃣ Check review approved for this project
  const { data: review, error: reviewError } = await supabase
    .from('participant_reviews')
    .select('id, allocation_id')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .eq('status', 'APPROVED')
    .maybeSingle();

  if (reviewError) throw reviewError;
  if (!review) return; // stop if no approved review

  // 2️⃣ Check purchase proof approved for this allocation
  const { data: proof, error: proofError } = await supabase
    .from('purchase_proofs')
    .select('id')
    .eq('allocation_id', review.allocation_id)
    .eq('participant_id', participantId)
    .eq('status', 'APPROVED')
    .maybeSingle();

  if (proofError) throw proofError;
  if (!proof) return; // stop if purchase not approved

  // 3️⃣ Prevent duplicate payout
  const { data: existing } = await supabase
    .from('payouts')
    .select('id')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (existing) return;

  // 4️⃣ Get reward
  const { data: project } = await supabase
    .from('projects')
    .select('reward')
    .eq('id', projectId)
    .maybeSingle();

  const rewardAmount = Number(project?.reward || 0);

  // 5️⃣ Get product value
  const { data: application } = await supabase
    .from('project_applications')
    .select('product_id, allocated_budget')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .in('status', ['APPROVED', 'PURCHASED'])
    .maybeSingle();

  let productAmount = Number(application?.allocated_budget || 0);

  if (!productAmount && application?.product_id) {
    const { data: product } = await supabase
      .from('project_products')
      .select('product_value')
      .eq('id', application.product_id)
      .maybeSingle();

    productAmount = Number(product?.product_value || 0);
  }

  const totalAmount = rewardAmount + productAmount;

  // 6️⃣ Insert payout
  const { error: insertError } = await supabase
    .from('payouts')
    .insert({
      participant_id: participantId,
      user_id: participantId,
      project_id: projectId,
      purchase_proof_id: proof.id,
      amount: totalAmount,
      status: 'ELIGIBLE'
    });
  if (insertError && isMissingSchemaObjectError(insertError)) {
    const fallbackInsert = await supabase
      .from('payouts')
      .insert({
        participant_id: participantId,
        project_id: projectId,
        purchase_proof_id: proof.id,
        amount: totalAmount,
        status: 'ELIGIBLE'
      });
    if (fallbackInsert.error && !isMissingSchemaObjectError(fallbackInsert.error)) {
      throw fallbackInsert.error;
    }
    if (!fallbackInsert.error) return;

    const fallbackInsertNoProof = await supabase
      .from('payouts')
      .insert({
        participant_id: participantId,
        project_id: projectId,
        amount: totalAmount,
        status: 'ELIGIBLE'
      });
    if (fallbackInsertNoProof.error) throw fallbackInsertNoProof.error;
    return;
  }

  if (insertError) throw insertError;
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

    let reviewProofRes = await supabase
      .from('participant_reviews')
      .select('id, status')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId)
      .eq('product_id', productId || null)
      .neq('status', 'REJECTED')
      .maybeSingle();

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

    let existingRes = await supabase
      .from('internal_feedbacks')
      .select('id')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId)
      .eq('product_id', productId || null)
      .maybeSingle();

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
      .single();

    if (insertRes.error && isMissingSchemaObjectError(insertRes.error)) {
      insertRes = await supabase
        .from('internal_feedbacks')
        .insert({
          allocation_id: allocationId,
          participant_id: participantId,
          project_id: allocation.project_id,
          rating: normalizedRating,
          feedback_text: String(feedbackText).trim()
        })
        .select()
        .single();
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

    let existingRes = await supabase
      .from('participant_reviews')
      .select('id, status')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId)
      .eq('product_id', productId || null)
      .maybeSingle();

    if (existingRes.error && isMissingSchemaObjectError(existingRes.error)) {
      existingRes = await supabase
        .from('participant_reviews')
        .select('id, status')
        .eq('allocation_id', allocationId)
        .eq('participant_id', participantId)
        .maybeSingle();
    }

    const existingError = existingRes.error;
    const existing = existingRes.data;

    if (existingError) throw existingError;
    const existingStatus = String(existing?.status || '').toUpperCase();
    if (existing && existingStatus !== 'REJECTED') {
      return res.status(400).json({
        success: false,
        message: 'Review already submitted for this allocation'
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
        .single();
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
        .single();

      if (writeRes.error && isMissingSchemaObjectError(writeRes.error)) {
        writeRes = await supabase
          .from('participant_reviews')
          .insert({
            allocation_id: allocationId,
            participant_id: participantId,
            project_id: allocation.project_id,
            review_text: String(reviewText || '').trim(),
            review_url: String(reviewUrl || '').trim(),
            status: 'PENDING'
          })
          .select()
          .single();
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
    const { data, error } = await supabase
      .from('participant_reviews')
      .select('id, allocation_id, participant_id, project_id, review_text, review_url, status, created_at')
      .eq('status', 'PENDING')
      .order('created_at', { ascending: true });

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

    let query = supabase
      .from('participant_reviews')
      .select('id, allocation_id, participant_id, project_id, review_text, review_url, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
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

    const { data: review, error } = await supabase
      .from('participant_reviews')
      .update({ status: 'APPROVED' })
      .eq('id', id)
      .eq('status', 'PENDING')
      .select('id, allocation_id, participant_id, project_id')
      .maybeSingle();

    if (error) throw error;
    let reviewRow = review;
    let alreadyProcessed = false;

    if (!reviewRow) {
      const { data: existingReview, error: existingReviewError } = await supabase
        .from('participant_reviews')
        .select('id, allocation_id, participant_id, project_id, status')
        .eq('id', id)
        .maybeSingle();
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

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('reward')
      .eq('id', reviewRow.project_id)
      .maybeSingle();
    if (!projectError) {
      try {
        await ensureEligiblePayout({
          participantId: reviewRow.participant_id,
          projectId: reviewRow.project_id,
          fallbackReward: project?.reward
        });
      } catch (sideEffectError) {
        console.error('approveReview ensureEligiblePayout warning:', sideEffectError);
      }
    }

    try {
      await markAllocationCompleted({
        allocationId: reviewRow.allocation_id,
        participantId: reviewRow.participant_id
      });
    } catch (allocationError) {
      console.error('approveReview markAllocationCompleted warning:', allocationError);
    }

    res.json({
      success: true,
      message: alreadyProcessed
        ? 'Review already approved'
        : 'Review approved and payout eligibility created'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', reviewRow.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: 'Review approved',
        html: '<p>Your review was approved and your payout is now eligible.</p>'
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
      .select('id, participant_id')
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
      .select('email')
      .eq('id', data.participant_id)
      .maybeSingle();

    if (participant?.email) {
      sendEmail({
        to: participant.email,
        subject: 'Review rejected',
        html: '<p>Your review was rejected. Please update and resubmit.</p>'
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
