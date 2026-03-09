const cron = require('node-cron');
const supabase = require('../config/supabaseClient');
const { sendEmail } = require('../services/email.service');
const {
  allocationReminderEmail,
  allocationExpiredEmail,
  adminBudgetRestoredEmail
} = require('../services/email.templates');

// ─────────────────────────────────────────────
// Reminder schedule (20-day window)
// Day 10 → 240h remaining, Day 15 → 120h, Day 18 → 48h, Day 19 → 24h
// ─────────────────────────────────────────────
const REMINDERS = [
  { dayNumber: 10, daysLeft: 10, hoursFromNow: 240, type: 'ALLOCATION_REMINDER_DAY10' },
  { dayNumber: 15, daysLeft:  5, hoursFromNow: 120, type: 'ALLOCATION_REMINDER_DAY15' },
  { dayNumber: 18, daysLeft:  2, hoursFromNow:  48, type: 'ALLOCATION_REMINDER_DAY18' },
  { dayNumber: 19, daysLeft:  1, hoursFromNow:  24, type: 'ALLOCATION_REMINDER_DAY19' }
];

const addHours = (date, hours) => new Date(date.getTime() + hours * 60 * 60 * 1000);
const toIso    = (value) => new Date(value).toISOString();

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

const buildMaps = async (rows) => {
  const participantIds = [...new Set(rows.map((r) => r?.participant_id).filter(Boolean))];
  const projectIds     = [...new Set(rows.map((r) => r?.project_id).filter(Boolean))];

  const [profilesRes, projectsRes] = await Promise.all([
    participantIds.length
      ? supabase.from('profiles').select('id, email, full_name').in('id', participantIds)
      : Promise.resolve({ data: [], error: null }),
    projectIds.length
      ? supabase.from('projects').select('id, title, name').in('id', projectIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (profilesRes.error && !isMissingSchemaObjectError(profilesRes.error)) throw profilesRes.error;
  if (projectsRes.error && !isMissingSchemaObjectError(projectsRes.error)) throw projectsRes.error;

  return {
    profileMap: new Map((profilesRes.data || []).map((r) => [r.id, r])),
    projectMap: new Map((projectsRes.data || []).map((r) => [r.id, r]))
  };
};

const getProductsForAllocation = async (participantId, projectId) => {
  if (!participantId || !projectId) return [];

  const appRes = await supabase
    .from('project_applications')
    .select('product_id, allocated_budget')
    .eq('participant_id', participantId)
    .eq('project_id', projectId)
    .eq('status', 'APPROVED');

  if (appRes.error) return [];

  const productIds = [...new Set((appRes.data || []).map((r) => r.product_id).filter(Boolean))];
  if (!productIds.length) return [];

  const { data: products, error } = await supabase
    .from('project_products')
    .select('id, name, image_url, product_url, product_value')
    .in('id', productIds);

  if (error || !products) return [];

  const budgetMap = new Map((appRes.data || []).map((r) => [r.product_id, r.allocated_budget]));
  return products.map((p) => ({
    name:          p.name,
    image_url:     p.image_url   || null,
    product_url:   p.product_url || null,
    product_value: budgetMap.get(p.id) ?? p.product_value ?? null
  }));
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
    .insert({ user_id: userId, type, title, message: `${message} ${marker}` });

  if (error && !isMissingSchemaObjectError(error)) throw error;
  return !error;
};

// ─────────────────────────────────────────────
// Process a single reminder window
// ─────────────────────────────────────────────
const processReminderWindow = async ({ dayNumber, daysLeft, hoursFromNow, type }) => {
  const now      = new Date();
  const startIso = toIso(addHours(now, hoursFromNow - 1));
  const endIso   = toIso(addHours(now, hoursFromNow));

  const { data, error } = await supabase
    .from('unit_allocations')
    .select('id, participant_id, project_id, reserved_until, status')
    .eq('status', 'RESERVED')
    .gt('reserved_until', startIso)
    .lte('reserved_until', endIso);

  if (error) {
    console.error(`Reminder day${dayNumber} query failed:`, error);
    return;
  }

  const rows = data || [];
  if (!rows.length) return;

  const { profileMap, projectMap } = await buildMaps(rows);

  for (const row of rows) {
    try {
      const userId       = row.participant_id;
      const allocationId = row.id;
      const projectName  = projectMap.get(row.project_id)?.title
        || projectMap.get(row.project_id)?.name
        || 'your project';
      const profile = profileMap.get(userId);

      await createNotification({
        userId,
        type,
        title:   `Reminder: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left to upload your invoice`,
        message: `Your reservation for ${projectName} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Please upload your invoice.`,
        allocationId
      });

      if (profile?.email) {
        const products = await getProductsForAllocation(userId, row.project_id);

        sendEmail({
          to: profile.email,
          subject: dayNumber === 19
            ? `🚨 Final Warning: 1 Day Left to Upload Your Invoice — ${projectName}`
            : dayNumber === 18
            ? `⚠️ Only 2 Days Left — Upload Your Invoice for ${projectName}`
            : `⏰ Reminder: ${daysLeft} Days to Submit Your Invoice — ${projectName}`,
          html: allocationReminderEmail({
            name:        profile.full_name,
            projectName,
            dayNumber,
            daysLeft,
            expiryDate:  row.reserved_until,
            products,
            dashboardUrl: 'https://nitro.com/dashboard'
          })
        });
      }
    } catch (err) {
      console.error(`Reminder day${dayNumber} failed for allocation ${row.id}:`, err);
    }
  }

  if (rows.length) console.log(`Reminder day${dayNumber}: processed ${rows.length} allocation(s)`);
};

// ─────────────────────────────────────────────
// Handle expired allocations:
//   1. Mark allocation EXPIRED
//   2. Reject project_applications (restores budget to pool)
//   3. Email participant
//   4. Notify all admins with budget restoration summary
// ─────────────────────────────────────────────
const processExpiredAllocations = async () => {
  const nowIso = new Date().toISOString();

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

  if (!data || data.length === 0) {
    console.log('No allocations to expire');
    return;
  }

  console.log(`Expiring ${data.length} allocation(s)...`);

  const { profileMap, projectMap } = await buildMaps(data);

  // Group expired slots by project for the admin summary email
  const projectExpiredMap = new Map();

  for (const row of data) {
    try {
      const userId       = row.participant_id;
      const allocationId = row.id;
      const profile      = profileMap.get(userId);
      const projectName  = projectMap.get(row.project_id)?.title
        || projectMap.get(row.project_id)?.name
        || 'your project';

      // ── Reject approved applications → frees allocated_budget from the spent total ──
      // The budget calculation in getPendingProductApplications sums allocated_budget
      // from rows WHERE status IN ('APPROVED','PURCHASED','COMPLETED').
      // Moving status to 'REJECTED' removes this row from that sum, restoring the budget.
      const appUpdateRes = await supabase
        .from('project_applications')
        .update({
          status:            'REJECTED',
          reviewed_at:       nowIso,
          eligibility_notes: 'Automatically rejected — invoice not submitted within the 20-day deadline.'
        })
        .eq('participant_id', userId)
        .eq('project_id',     row.project_id)
        .eq('status',         'APPROVED')
        .select('id, product_id, allocated_budget');

      if (appUpdateRes.error && !isMissingSchemaObjectError(appUpdateRes.error)) {
        console.error(`Failed to reject applications for allocation ${allocationId}:`, appUpdateRes.error);
      }

      const rejectedApps = appUpdateRes.data || [];

      // ── Fetch product details for emails ────────────────────────────────
      const productIds = [...new Set(rejectedApps.map((a) => a.product_id).filter(Boolean))];
      let products  = [];
      let slotAmount = 0;

      if (productIds.length) {
        const { data: productRows } = await supabase
          .from('project_products')
          .select('id, name, image_url, product_url, product_value')
          .in('id', productIds);

        const budgetMap = new Map(rejectedApps.map((a) => [a.product_id, a.allocated_budget]));
        products = (productRows || []).map((p) => ({
          name:          p.name,
          image_url:     p.image_url   || null,
          product_url:   p.product_url || null,
          product_value: budgetMap.get(p.id) ?? p.product_value ?? null
        }));
        slotAmount = rejectedApps.reduce((sum, a) => sum + Number(a.allocated_budget || 0), 0);
      }

      // ── In-app notification for participant ──────────────────────────────
      await createNotification({
        userId,
        type:    'ALLOCATION_EXPIRED',
        title:   'Reservation cancelled',
        message: `Your reservation for ${projectName} has been cancelled — invoice deadline passed.`,
        allocationId
      });

      // ── Email participant ────────────────────────────────────────────────
      if (profile?.email) {
        sendEmail({
          to:      profile.email,
          subject: `Reservation Cancelled — ${projectName}`,
          html:    allocationExpiredEmail({
            name:       profile.full_name,
            projectName,
            products,
            reapplyUrl: 'https://nitro.com/projects'
          })
        });
      }

      // ── Accumulate for admin summary ─────────────────────────────────────
      if (!projectExpiredMap.has(row.project_id)) {
        projectExpiredMap.set(row.project_id, { projectName, slots: [], totalRestored: 0 });
      }
      const entry = projectExpiredMap.get(row.project_id);
      entry.slots.push({
        participantName:  profile?.full_name  || 'Participant',
        participantEmail: profile?.email      || '',
        products,
        slotAmount
      });
      entry.totalRestored += slotAmount;

    } catch (err) {
      console.error(`Expiry processing failed for allocation ${row.id}:`, err);
    }
  }

  // ── Notify all admins ────────────────────────────────────────────────────
  if (projectExpiredMap.size === 0) return;

  const { data: adminProfiles, error: adminError } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .in('role', ['ADMIN', 'SUPER_ADMIN'])
    .eq('status', 'APPROVED');

  if (adminError && !isMissingSchemaObjectError(adminError)) {
    console.error('Failed to fetch admin profiles for budget notification:', adminError);
    return;
  }

  const admins = adminProfiles || [];
  if (!admins.length) return;

  for (const [projectId, { projectName, slots, totalRestored }] of projectExpiredMap.entries()) {
    for (const admin of admins) {
      try {
        await supabase
          .from('notifications')
          .insert({
            user_id: admin.id,
            type:    'BUDGET_RESTORED',
            title:   'Budget restored — expired reservations',
            message: `${slots.length} slot${slots.length > 1 ? 's' : ''} expired in "${projectName}". ₹${Number(totalRestored).toLocaleString('en-IN')} released back to project budget. [project:${projectId}]`
          });

        if (admin.email) {
          sendEmail({
            to:      admin.email,
            subject: `💰 Budget Restored: ${slots.length} Slot${slots.length > 1 ? 's' : ''} Released — ${projectName}`,
            html:    adminBudgetRestoredEmail({
              adminName:      admin.full_name || 'Admin',
              projectName,
              projectId,
              expiredSlots:   slots,
              restoredAmount: totalRestored,
              dashboardUrl:   'https://nitro.com/admin/product-applications'
            })
          });
        }
      } catch (err) {
        console.error(`Admin notification failed for admin ${admin.id}:`, err);
      }
    }
  }

  console.log(`Expired ${data.length} allocation(s). Notified ${admins.length} admin(s) across ${projectExpiredMap.size} project(s).`);
};

// ─────────────────────────────────────────────
// Cron job — runs every hour
// ─────────────────────────────────────────────
const startAllocationExpiryJob = () => {
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('Running allocation expiry/reminder job...');

      for (const reminder of REMINDERS) {
        await processReminderWindow(reminder);
      }

      await processExpiredAllocations();

    } catch (err) {
      console.error('Allocation expiry/reminder job failed:', err);
    }
  });
};

module.exports = startAllocationExpiryJob;