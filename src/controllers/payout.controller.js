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
const { calculatePayoutBreakdown } = require('../utils/payout.utils');

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
        payout_batch_id,
        participant_id,
        project_id,
        projects (
          id,
          title,
          name
        )
      `
      )
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const breakdownCache = new Map();
    const enriched = await Promise.all((data || []).map(async (row) => {
      const cacheKey = `${row.participant_id}::${row.project_id}`;
      let breakdown = breakdownCache.get(cacheKey);
      if (!breakdown) {
        breakdown = await calculatePayoutBreakdown({
          supabase,
          participantId: row.participant_id,
          projectId: row.project_id
        });
        breakdownCache.set(cacheKey, breakdown);
      }

      const totalAmount = Number(row.amount || breakdown.totalAmount || 0);
      return {
        ...row,
        reward_amount: breakdown.rewardAmount,
        product_amount: breakdown.productAmount,
        total_amount: totalAmount,
        eligibility_reason: String(row.status || '').toUpperCase() === 'PAID'
          ? 'Payout paid successfully'
          : String(row.status || '').toUpperCase() === 'IN_BATCH'
            ? 'Included in payout batch'
            : String(row.status || '').toUpperCase() === 'EXPORTED'
              ? 'Batch exported and waiting for transfer'
              : 'Payout eligible and waiting for batch processing'
      };
    }));

    res.json({
      success: true,
      data: enriched
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
