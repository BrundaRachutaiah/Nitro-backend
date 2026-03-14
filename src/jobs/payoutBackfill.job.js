const cron = require('node-cron');

const { backfillEligiblePayouts, deduplicatePayoutRows } = require('../controllers/payout.controller');

const isEnabled = () => {
  const raw = String(process.env.ENABLE_PAYOUT_BACKFILL_JOB ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
};

const startPayoutBackfillJob = () => {
  if (!isEnabled()) {
    console.log('[payoutBackfill.job] Disabled via ENABLE_PAYOUT_BACKFILL_JOB');
    return;
  }

  // Runs every 30 minutes. Keeps legacy/edge-case payouts in sync without doing DB writes
  // on every admin page load.
  cron.schedule('*/30 * * * *', async () => {
    try {
      console.log('[payoutBackfill.job] Running backfillEligiblePayouts...');
      await backfillEligiblePayouts();

      // Best-effort cleanup for historical duplicates. This does not replace a DB-level unique constraint.
      await deduplicatePayoutRows();
    } catch (err) {
      console.error('[payoutBackfill.job] Failed:', err?.message || err);
    }
  });
};

module.exports = startPayoutBackfillJob;

