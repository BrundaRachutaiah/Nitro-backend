const supabase = require('../config/supabaseClient');
const { PROOF_STATUS } = require('../utils/constants');

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
      .select()
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
      .select()
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
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPendingPurchaseProofs,
  approvePurchaseProof,
  rejectPurchaseProof
};
