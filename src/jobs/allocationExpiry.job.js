const cron = require('node-cron');
const supabase = require('../config/supabaseClient');
const { sendEmail } = require('../services/email.service');
const {
  allocationReminderEmail,
  allocationExpiredEmail
} = require('../services/email.templates');

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

const addHours = (date, hours) => new Date(date.getTime() + hours * 60 * 60 * 1000);
const toIso = (value) => new Date(value).toISOString();

const buildMaps = async (rows) => {
  const participantIds = [...new Set(rows.map((row) => row?.participant_id).filter(Boolean))];
  const projectIds = [...new Set(rows.map((row) => row?.project_id).filter(Boolean))];

  const [profilesRes, projectsRes] = await Promise.all([
    participantIds.length
      ? supabase
          .from('profiles')
          .select('id, email, full_name')
          .in('id', participantIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? supabase
          .from('projects')
          .select('id, title, name')
          .in('id', projectIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (profilesRes.error && !isMissingSchemaObjectError(profilesRes.error)) {
    throw profilesRes.error;
  }

  if (projectsRes.error && !isMissingSchemaObjectError(projectsRes.error)) {
    throw projectsRes.error;
  }

  return {
    profileMap: new Map((profilesRes.data || []).map((row) => [row.id, row])),
    projectMap: new Map((projectsRes.data || []).map((row) => [row.id, row]))
  };
};

const notificationExists = async ({ userId, type, allocationId }) => {
  const marker = `[allocation:${allocationId}]`;
  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .ilike('message', `%${marker}%`)
    .limit(1);

  if (error) {
    if (isMissingSchemaObjectError(error)) return false;
    throw error;
  }

  return Array.isArray(data) && data.length > 0;
};

const createNotification = async ({ userId, type, title, message, allocationId }) => {
  const marker = `[allocation:${allocationId}]`;
  const alreadyExists = await notificationExists({ userId, type, allocationId });
  if (alreadyExists) return false;

  const { error } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type,
      title,
      message: `${message} ${marker}`
    });

  if (error && !isMissingSchemaObjectError(error)) {
    throw error;
  }

  return !error;
};

const processReminderWindow = async ({ startIso, endIso, hoursLeft }) => {
  const { data, error } = await supabase
    .from('unit_allocations')
    .select('id, participant_id, project_id, reserved_until, status')
    .eq('status', 'RESERVED')
    .gt('reserved_until', startIso)
    .lte('reserved_until', endIso);

  if (error) {
    console.error(`Reminder ${hoursLeft}h query failed:`, error);
    return;
  }

  const rows = data || [];
  if (!rows.length) return;

  const { profileMap, projectMap } = await buildMaps(rows);

  for (const row of rows) {
    try {
      const userId = row.participant_id;
      const allocationId = row.id;
      const projectName = projectMap.get(row.project_id)?.title
        || projectMap.get(row.project_id)?.name
        || 'your project';
      const profile = profileMap.get(userId);
      const type = hoursLeft === 48 ? 'ALLOCATION_REMINDER_48H' : 'ALLOCATION_REMINDER_24H';

      await createNotification({
        userId,
        type,
        title: `Reservation reminder: ${hoursLeft}h left`,
        message: `Your reservation for ${projectName} expires in ${hoursLeft} hours. Please upload invoice/proof in time.`,
        allocationId
      });

      if (profile?.email) {
        sendEmail({
          to: profile.email,
          subject: `⏰ Only ${hoursLeft} Hours Left to Upload Your Invoice`,
          html: allocationReminderEmail({
            name: profile.full_name,
            projectName,
            hoursLeft,
            expiryDate: new Date(row.reserved_until).toLocaleString()
          })
        });
      }
    } catch (err) {
      console.error(`Reminder ${hoursLeft}h send failed for allocation ${row.id}:`, err);
    }
  }
};

/**
 * Auto-expire reserved allocations + send reminders.
 * Runs every hour.
 */
const startAllocationExpiryJob = () => {
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('Running allocation expiry/reminder job...');

      const now = new Date();
      const nowIso = now.toISOString();

      // One-time reminder windows.
      await processReminderWindow({
        startIso: toIso(addHours(now, 47)),
        endIso: toIso(addHours(now, 48)),
        hoursLeft: 48
      });

      await processReminderWindow({
        startIso: toIso(addHours(now, 23)),
        endIso: toIso(addHours(now, 24)),
        hoursLeft: 24
      });

      const { data, error } = await supabase
        .from('unit_allocations')
        .update({ status: 'EXPIRED' })
        .eq('status', 'RESERVED')
        .lt('reserved_until', nowIso)
        .select('id, participant_id, project_id, reserved_until, status');

      if (error) {
        console.error('Allocation expiry error:', error);
        return;
      }

      if (data.length > 0) {
        const { profileMap, projectMap } = await buildMaps(data);

        for (const row of data) {
          try {
            const userId = row.participant_id;
            const allocationId = row.id;
            const projectName = projectMap.get(row.project_id)?.title
              || projectMap.get(row.project_id)?.name
              || 'your project';
            const profile = profileMap.get(userId);

            await createNotification({
              userId,
              type: 'ALLOCATION_EXPIRED',
              title: 'Reservation expired',
              message: `Your reservation for ${projectName} has expired.`,
              allocationId
            });

            if (profile?.email) {
              sendEmail({
                to: profile.email,
                subject: 'Reservation Expired — Re-apply for Your Project',
                html: allocationExpiredEmail({
                  name: profile.full_name,
                  projectName
                })
              });
            }
          } catch (err) {
            console.error(`Expiry notification failed for allocation ${row.id}:`, err);
          }
        }

        console.log(`Expired ${data.length} allocations`);
      } else {
        console.log('No allocations to expire');
      }
    } catch (err) {
      console.error('Allocation expiry/reminder job failed:', err);
    }
  });
};

module.exports = startAllocationExpiryJob;