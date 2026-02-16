const supabase = require('../config/supabaseClient');
const { sendEmail } = require('../services/email.service');

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

const hasApprovedProof = async (allocationId, participantId) => {
  const { data, error } = await supabase
    .from('purchase_proofs')
    .select('id, status')
    .eq('allocation_id', allocationId)
    .eq('participant_id', participantId)
    .eq('status', 'APPROVED')
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
};

const ensureEligiblePayout = async ({ participantId, projectId, amount, purchaseProofId = null }) => {
  const { data: existing, error: lookupError } = await supabase
    .from('payouts')
    .select('id')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) return;

  const { error: insertError } = await supabase
    .from('payouts')
    .insert({
      participant_id: participantId,
      project_id: projectId,
      purchase_proof_id: purchaseProofId,
      amount: Number(amount) || 0,
      status: 'ELIGIBLE'
    });

  if (insertError) throw insertError;
};

const submitFeedback = async (req, res, next) => {
  try {
    const participantId = req.user.id;
    const { allocationId, rating, feedbackText } = req.body;

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

    const approvedProof = await hasApprovedProof(allocationId, participantId);
    if (!approvedProof) {
      return res.status(400).json({
        success: false,
        message: 'Approved purchase proof is required before feedback submission'
      });
    }

    const normalizedRating = Number(rating);
    if (!Number.isFinite(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
      return res.status(400).json({
        success: false,
        message: 'rating must be between 1 and 5'
      });
    }

    const { data: existing, error: existingError } = await supabase
      .from('internal_feedbacks')
      .select('id')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Feedback already submitted for this allocation'
      });
    }

    const { data, error } = await supabase
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

    if (error) throw error;

    await ensureEligiblePayout({
      participantId,
      projectId: allocation.project_id,
      amount: allocation?.projects?.reward
    });

    await supabase
      .from('unit_allocations')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', allocationId)
      .eq('participant_id', participantId)
      .is('completed_at', null);

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
    const { allocationId, reviewText, reviewUrl } = req.body;

    if (!allocationId || !reviewText || !reviewUrl) {
      return res.status(400).json({
        success: false,
        message: 'allocationId, reviewText, and reviewUrl are required'
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
    if (projectMode !== 'D2C') {
      return res.status(400).json({
        success: false,
        message: 'External review submission is only allowed for D2C mode'
      });
    }

    const approvedProof = await hasApprovedProof(allocationId, participantId);
    if (!approvedProof) {
      return res.status(400).json({
        success: false,
        message: 'Approved purchase proof is required before review submission'
      });
    }

    const { data: existing, error: existingError } = await supabase
      .from('participant_reviews')
      .select('id')
      .eq('allocation_id', allocationId)
      .eq('participant_id', participantId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Review already submitted for this allocation'
      });
    }

    const { data, error } = await supabase
      .from('participant_reviews')
      .insert({
        allocation_id: allocationId,
        participant_id: participantId,
        project_id: allocation.project_id,
        review_text: String(reviewText).trim(),
        review_url: String(reviewUrl).trim(),
        status: 'PENDING'
      })
      .select()
      .single();

    if (error) throw error;

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

    res.json({
      success: true,
      data: data || []
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
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or already processed'
      });
    }

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('reward')
      .eq('id', review.project_id)
      .maybeSingle();

    if (projectError) throw projectError;

    await ensureEligiblePayout({
      participantId: review.participant_id,
      projectId: review.project_id,
      amount: project?.reward
    });

    await supabase
      .from('unit_allocations')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', review.allocation_id)
      .eq('participant_id', review.participant_id)
      .is('completed_at', null);

    res.json({
      success: true,
      message: 'Review approved and payout eligibility created'
    });

    const { data: participant } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', review.participant_id)
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
  getPendingReviews,
  approveReview,
  rejectReview
};
