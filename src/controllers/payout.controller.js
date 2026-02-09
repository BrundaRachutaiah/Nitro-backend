/**
 * Payout controller - MVP placeholder
 */

const createPayoutBatch = (req, res) => {
  res.json({
    success: true,
    message: 'Payout batch creation not implemented yet'
  });
};

const getPayoutBatches = (req, res) => {
  res.json({
    success: true,
    message: 'Payout list not implemented yet'
  });
};

const supabase = require('../config/supabaseClient');

const getMyPayouts = async (req, res, next) => {
  try {
    const participantId = req.user.id;

    const { data, error } = await supabase
      .from('payouts')
      .select(
        `
        id,
        amount,
        status,
        created_at,
        projects (
          id,
          title
        )
      `
      )
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createPayoutBatch,
  getPayoutBatches,
  getMyPayouts
};
