const supabase = require('../config/supabaseClient');
const { PROOF_STATUS } = require('../utils/constants');
const { sendEmail } = require('../services/email.service');
const {
  purchaseApprovedEmail,
  purchaseRejectedEmail
} = require('../services/email.templates');

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

    res.json({ success: true, data });
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

    res.json({ success: true, data: data || [] });
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
