const cron = require('node-cron');
const supabase = require('../config/supabaseClient');
const { PROJECT_STATUS } = require('../utils/constants');

/**
 * Auto-update project statuses by start/end date.
 * Runs every hour.
 *
 * Rules:
 * - draft + start_date <= now + end_date >= now => published
 * - published + end_date < now => archived
 */
const startProjectStatusJob = () => {
  cron.schedule('0 * * * *', async () => {
    try {
      const nowIso = new Date().toISOString();

      const { data: toPublish, error: publishLookupError } = await supabase
        .from('projects')
        .select('id')
        .eq('status', PROJECT_STATUS.DRAFT)
        .lte('start_date', nowIso)
        .gte('end_date', nowIso);

      if (publishLookupError) {
        console.error('Project status publish lookup error:', publishLookupError);
      } else if ((toPublish || []).length) {
        const ids = toPublish.map((row) => row.id);
        const { error: publishError } = await supabase
          .from('projects')
          .update({ status: PROJECT_STATUS.PUBLISHED })
          .in('id', ids);

        if (publishError) {
          console.error('Project auto-publish error:', publishError);
        }
      }

      const { data: toArchive, error: archiveLookupError } = await supabase
        .from('projects')
        .select('id')
        .eq('status', PROJECT_STATUS.PUBLISHED)
        .lt('end_date', nowIso);

      if (archiveLookupError) {
        console.error('Project status archive lookup error:', archiveLookupError);
      } else if ((toArchive || []).length) {
        const ids = toArchive.map((row) => row.id);
        const { error: archiveError } = await supabase
          .from('projects')
          .update({ status: PROJECT_STATUS.ARCHIVED })
          .in('id', ids);

        if (archiveError) {
          console.error('Project auto-archive error:', archiveError);
        }
      }
    } catch (err) {
      console.error('Project status job failed:', err);
    }
  });
};

module.exports = startProjectStatusJob;
