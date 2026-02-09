const cron = require('node-cron');
const supabase = require('../config/supabaseClient');

/**
 * Auto-expire reserved allocations
 * Runs every hour
 */
const startAllocationExpiryJob = () => {
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('⏰ Running allocation expiry job...');

      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from('unit_allocations')
        .update({ status: 'EXPIRED' })
        .eq('status', 'RESERVED')
        .lt('reserved_until', now)
        .select();

      if (error) {
        console.error('❌ Allocation expiry error:', error);
        return;
      }

      if (data.length > 0) {
        console.log(`✅ Expired ${data.length} allocations`);
      } else {
        console.log('ℹ️ No allocations to expire');
      }
    } catch (err) {
      console.error('❌ Allocation expiry job failed:', err);
    }
  });
};

module.exports = startAllocationExpiryJob;
