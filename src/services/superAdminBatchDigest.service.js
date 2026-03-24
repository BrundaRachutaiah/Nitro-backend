const supabase = require('../config/supabaseClient');
const { sendEmail } = require('./email.service');

const WINDOW_MS = Math.max(1, Number(process.env.SUPER_ADMIN_BATCH_WINDOW_MS || 30_000));
const ENABLED = String(process.env.SUPER_ADMIN_BATCH_DIGEST_ENABLED || 'true').toLowerCase() === 'true';

let flushTimer = null;

const buffer = {
  firstQueuedAt: null,
  lastQueuedAt: null,
  requestIds: new Set(),
  invoiceIds: new Set(),
  reviewIds: new Set()
};

const resetBuffer = () => {
  buffer.firstQueuedAt = null;
  buffer.lastQueuedAt = null;
  buffer.requestIds = new Set();
  buffer.invoiceIds = new Set();
  buffer.reviewIds = new Set();
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildHtml = ({ requests, invoices, reviews }) => {
  const total = requests.length + invoices.length + reviews.length;
  const heading = total === 1 ? '1 new item needs review' : `${total} new items need review`;

  const list = (items, render) => {
    if (!items.length) return '<p style="margin:0;color:#6b7280;">None</p>';
    return `
      <ul style="margin:0;padding-left:18px;color:#111827;">
        ${items.map((i) => `<li style="margin:6px 0;">${render(i)}</li>`).join('')}
      </ul>`;
  };

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f6f7fb;padding:24px;">
    <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <div style="padding:18px 22px;background:#111827;color:#fff;">
        <div style="font-size:14px;opacity:.9;">Nitro</div>
        <div style="font-size:18px;font-weight:700;margin-top:6px;">${escapeHtml(heading)}</div>
      </div>

      <div style="padding:18px 22px;">
        <h3 style="margin:0 0 8px;font-size:14px;color:#111827;">New Product Requests</h3>
        ${list(requests, (r) => `<strong>${escapeHtml(r.participantLabel)}</strong> requested <em>${escapeHtml(r.productName)}</em> (${escapeHtml(r.projectTitle)})`) }

        <div style="height:14px;"></div>

        <h3 style="margin:0 0 8px;font-size:14px;color:#111827;">Invoices Uploaded</h3>
        ${list(invoices, (r) => `<strong>${escapeHtml(r.participantLabel)}</strong> uploaded invoice (${escapeHtml(r.projectTitle)})`) }

        <div style="height:14px;"></div>

        <h3 style="margin:0 0 8px;font-size:14px;color:#111827;">Reviews Submitted</h3>
        ${list(reviews, (r) => `<strong>${escapeHtml(r.participantLabel)}</strong> submitted review (${escapeHtml(r.projectTitle)})`) }

        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;">
          This email batches activity for ${Math.round(WINDOW_MS / 1000)}s to reduce spam.
        </div>
      </div>
    </div>
  </div>`;
};

const getParticipantLabelMap = async (participantIds) => {
  const ids = [...new Set((participantIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);

  if (error) throw error;

  return new Map(
    (data || []).map((p) => [
      p.id,
      p.full_name || p.email || p.id
    ])
  );
};

const fetchRealtimeItems = async ({ requestIds, invoiceIds, reviewIds }) => {
  const requests = [];
  const invoices = [];
  const reviews = [];

  const requestIdList = [...new Set((requestIds || []).filter(Boolean))];
  const invoiceIdList = [...new Set((invoiceIds || []).filter(Boolean))];
  const reviewIdList = [...new Set((reviewIds || []).filter(Boolean))];

  let requestRows = [];
  let invoiceRows = [];
  let reviewRows = [];

  if (requestIdList.length) {
    const { data, error } = await supabase
      .from('project_applications')
      .select(
        `
        id,
        created_at,
        participant_id,
        project_id,
        product_id,
        project_products ( name ),
        projects ( title )
      `
      )
      .in('id', requestIdList);
    if (error) throw error;
    requestRows = data || [];
  }

  if (invoiceIdList.length) {
    const { data, error } = await supabase
      .from('purchase_proofs')
      .select('id, uploaded_at, participant_id, allocation_id, product_id')
      .in('id', invoiceIdList);
    if (error) throw error;
    invoiceRows = data || [];
  }

  if (reviewIdList.length) {
    const { data, error } = await supabase
      .from('participant_reviews')
      .select(
        `
        id,
        created_at,
        participant_id,
        project_id,
        product_id,
        projects ( title )
      `
      )
      .in('id', reviewIdList);
    if (error) throw error;
    reviewRows = data || [];
  }

  const participantIds = [
    ...requestRows.map((r) => r.participant_id),
    ...invoiceRows.map((r) => r.participant_id),
    ...reviewRows.map((r) => r.participant_id)
  ].filter(Boolean);

  const participantLabelMap = await getParticipantLabelMap(participantIds);

  // Allocation -> project title lookup for invoices (best-effort).
  const allocationIds = [...new Set(invoiceRows.map((r) => r.allocation_id).filter(Boolean))];
  let allocationTitleMap = new Map();
  if (allocationIds.length) {
    const { data, error } = await supabase
      .from('unit_allocations')
      .select('id, projects(title)')
      .in('id', allocationIds);
    if (error) throw error;
    allocationTitleMap = new Map((data || []).map((row) => [row.id, row.projects?.title || '—']));
  }

  for (const row of requestRows) {
    requests.push({
      id: row.id,
      participantLabel: participantLabelMap.get(row.participant_id) || row.participant_id,
      productName: row.project_products?.name || '—',
      projectTitle: row.projects?.title || '—',
      createdAt: row.created_at
    });
  }

  for (const row of invoiceRows) {
    invoices.push({
      id: row.id,
      participantLabel: participantLabelMap.get(row.participant_id) || row.participant_id,
      projectTitle: allocationTitleMap.get(row.allocation_id) || '—',
      createdAt: row.uploaded_at || null
    });
  }

  for (const row of reviewRows) {
    reviews.push({
      id: row.id,
      participantLabel: participantLabelMap.get(row.participant_id) || row.participant_id,
      projectTitle: row.projects?.title || '—',
      createdAt: row.created_at
    });
  }

  return { requests, invoices, reviews };
};

const flushSuperAdminBatchDigest = async () => {
  const snapshot = {
    requestIds: [...buffer.requestIds],
    invoiceIds: [...buffer.invoiceIds],
    reviewIds: [...buffer.reviewIds]
  };

  flushTimer = null;
  resetBuffer();

  const total =
    snapshot.requestIds.length + snapshot.invoiceIds.length + snapshot.reviewIds.length;
  if (!total) return;

  try {
    const { data: superAdmins, error: adminError } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('role', 'SUPER_ADMIN')
      .eq('status', 'APPROVED');

    if (adminError) throw adminError;
    const recipients = (superAdmins || []).filter((a) => Boolean(a.email));
    if (!recipients.length) return;

    const { requests, invoices, reviews } = await fetchRealtimeItems(snapshot);
    const html = buildHtml({ requests, invoices, reviews });

    const subjectTotal = requests.length + invoices.length + reviews.length;
    const subject =
      subjectTotal === 1
        ? 'Nitro - 1 new item needs review'
        : `Nitro - ${subjectTotal} new items need review`;

    for (const admin of recipients) {
      const result = await sendEmail({ to: admin.email, subject, html });
      if (result.success) {
        console.log(`[SuperAdminBatchDigest] Sent to ${admin.email}`);
      } else {
        console.error(`[SuperAdminBatchDigest] Failed to send to ${admin.email}:`, result.error?.message);
      }
    }
  } catch (err) {
    console.error('[SuperAdminBatchDigest] Flush failed:', err?.message || err);
  }
};

const queueSuperAdminBatchDigestItem = ({ kind, id }) => {
  if (!ENABLED) return;
  if (!id) return;

  const normalizedKind = String(kind || '').trim().toUpperCase();
  const now = Date.now();
  if (!buffer.firstQueuedAt) buffer.firstQueuedAt = now;
  buffer.lastQueuedAt = now;

  if (normalizedKind === 'REQUEST') buffer.requestIds.add(id);
  else if (normalizedKind === 'INVOICE') buffer.invoiceIds.add(id);
  else if (normalizedKind === 'REVIEW') buffer.reviewIds.add(id);
  else return;

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushSuperAdminBatchDigest();
  }, WINDOW_MS);
};

module.exports = {
  queueSuperAdminBatchDigestItem,
  flushSuperAdminBatchDigest
};

