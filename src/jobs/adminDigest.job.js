/**
 * Nitro — Admin Daily Digest Job
 *
 * Runs every day at 8:00 AM.
 * Collects all activity from the past 24 hours:
 *   - New product requests (participants who applied)
 *   - Invoices uploaded (pending review)
 *   - Reviews submitted (pending approval)
 *
 * Sends ONE summary email to all ADMIN and SUPER_ADMIN users.
 */

const cron = require('node-cron');
const supabase = require('../config/supabaseClient');
const { sendEmail } = require('../services/email.service');

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0
  }).format(Number(n || 0));

const fmtDate = (d) =>
  d ? new Date(d).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }) : '—';

// ── Build the digest HTML ────────────────────────────────────────────────────

const buildAdminDigestHtml = ({ adminName, date, requests, invoices, reviews }) => {
  const hasAnything = requests.length || invoices.length || reviews.length;

  const sectionTitle = (icon, title, count) => `
    <tr>
      <td style="padding:20px 0 12px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:18px;">${icon}</span>
          <span style="font-size:16px;font-weight:700;color:#1a1a2e;">${title}</span>
          <span style="margin-left:8px;display:inline-block;padding:2px 10px;
                       background:#e94560;color:#fff;border-radius:20px;
                       font-size:12px;font-weight:700;">${count}</span>
        </div>
      </td>
    </tr>`;

  const tableHeader = (cols) => `
    <tr style="background:#f0f2f5;">
      ${cols.map((c) => `<th style="padding:10px 14px;font-size:11px;color:#9aa3b2;
        font-weight:700;text-transform:uppercase;letter-spacing:0.5px;
        text-align:left;border-bottom:1px solid #edf0f7;">${c}</th>`).join('')}
    </tr>`;

  const tableRow = (cells, highlight = false) => `
    <tr style="${highlight ? 'background:#fffbf0;' : ''}">
      ${cells.map((c) => `<td style="padding:10px 14px;font-size:13px;
        color:#4a5568;border-bottom:1px solid #edf0f7;vertical-align:top;">${c}</td>`).join('')}
    </tr>`;

  // ── Section: Product Requests ──
  const requestsSection = requests.length ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${sectionTitle('🛍', 'New Product Requests', requests.length)}
      <tr>
        <td>
          <table cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border:1px solid #edf0f7;border-radius:10px;overflow:hidden;">
            ${tableHeader(['Participant', 'Product', 'Project', 'Requested At'])}
            ${requests.map((r) => tableRow([
              `<strong>${r.participant_name || r.participant_email || '—'}</strong>
               ${r.participant_email ? `<br/><span style="font-size:11px;color:#9aa3b2;">${r.participant_email}</span>` : ''}`,
              r.product_name || '—',
              r.project_title || '—',
              fmtDate(r.created_at)
            ])).join('')}
          </table>
        </td>
      </tr>
    </table>` : '';

  // ── Section: Invoices Uploaded ──
  const invoicesSection = invoices.length ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;">
      ${sectionTitle('📄', 'Invoices Uploaded — Pending Review', invoices.length)}
      <tr>
        <td>
          <table cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border:1px solid #edf0f7;border-radius:10px;overflow:hidden;">
            ${tableHeader(['Participant', 'Product', 'Project', 'Uploaded At'])}
            ${invoices.map((r) => tableRow([
              `<strong>${r.participant_name || r.participant_email || '—'}</strong>
               ${r.participant_email ? `<br/><span style="font-size:11px;color:#9aa3b2;">${r.participant_email}</span>` : ''}`,
              r.product_name || '—',
              r.project_title || '—',
              fmtDate(r.uploaded_at || r.created_at)
            ], true)).join('')}
          </table>
        </td>
      </tr>
    </table>` : '';

  // ── Section: Reviews Submitted ──
  const reviewsSection = reviews.length ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;">
      ${sectionTitle('⭐', 'Reviews Submitted — Pending Approval', reviews.length)}
      <tr>
        <td>
          <table cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border:1px solid #edf0f7;border-radius:10px;overflow:hidden;">
            ${tableHeader(['Participant', 'Product', 'Project', 'Submitted At'])}
            ${reviews.map((r) => tableRow([
              `<strong>${r.participant_name || r.participant_email || '—'}</strong>
               ${r.participant_email ? `<br/><span style="font-size:11px;color:#9aa3b2;">${r.participant_email}</span>` : ''}`,
              r.product_name || '—',
              r.project_title || '—',
              fmtDate(r.created_at)
            ], true)).join('')}
          </table>
        </td>
      </tr>
    </table>` : '';

  const noActivitySection = !hasAnything ? `
    <div style="text-align:center;padding:40px 20px;background:#f8f9fc;
                border-radius:10px;border:1px solid #edf0f7;">
      <div style="font-size:36px;margin-bottom:12px;">✅</div>
      <p style="margin:0;font-size:15px;color:#9aa3b2;">
        No new activity in the last 24 hours. Everything is up to date!
      </p>
    </div>` : '';

  const summaryBar = hasAnything ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%"
           style="background:#f8f9fc;border-radius:10px;border:1px solid #edf0f7;
                  margin-bottom:28px;overflow:hidden;">
      <tr>
        <td style="padding:16px 20px;text-align:center;border-right:1px solid #edf0f7;">
          <div style="font-size:28px;font-weight:800;color:#e94560;">${requests.length}</div>
          <div style="font-size:12px;color:#9aa3b2;font-weight:600;margin-top:4px;">Product Requests</div>
        </td>
        <td style="padding:16px 20px;text-align:center;border-right:1px solid #edf0f7;">
          <div style="font-size:28px;font-weight:800;color:#f39c12;">${invoices.length}</div>
          <div style="font-size:12px;color:#9aa3b2;font-weight:600;margin-top:4px;">Invoices Pending</div>
        </td>
        <td style="padding:16px 20px;text-align:center;">
          <div style="font-size:28px;font-weight:800;color:#27ae60;">${reviews.length}</div>
          <div style="font-size:12px;color:#9aa3b2;font-weight:600;margin-top:4px;">Reviews Pending</div>
        </td>
      </tr>
    </table>` : '';

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Nitro Daily Digest</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f4f6f9;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="640" cellpadding="0" cellspacing="0" border="0"
               style="max-width:640px;width:100%;background:#fff;border-radius:12px;
                      overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%);
                        padding:36px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <span style="font-size:26px;font-weight:800;color:#fff;
                                 letter-spacing:3px;text-transform:uppercase;">NITRO</span>
                    <div style="width:40px;height:3px;background:#e94560;
                                margin:8px 0 0;border-radius:2px;"></div>
                  </td>
                  <td style="text-align:right;">
                    <span style="font-size:12px;color:#8fa8c8;letter-spacing:1px;
                                 text-transform:uppercase;">Daily Admin Digest</span>
                    <div style="font-size:13px;color:#fff;margin-top:4px;font-weight:600;">
                      ${date}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;">
              <h2 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#1a1a2e;">
                Good morning, ${adminName || 'Admin'}! 👋
              </h2>
              <p style="margin:0 0 28px;font-size:15px;color:#9aa3b2;">
                Here's your daily summary of participant activity from the last 24 hours.
              </p>

              ${summaryBar}
              ${noActivitySection}
              ${requestsSection}
              ${invoicesSection}
              ${reviewsSection}

              ${hasAnything ? `
              <table cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
                <tr>
                  <td style="background:linear-gradient(135deg,#e94560,#c0392b);
                              border-radius:8px;">
                    <a href="${frontendUrl}/admin/applications/product-applications"
                       target="_blank"
                       style="display:inline-block;padding:14px 32px;font-size:15px;
                              font-weight:700;color:#fff;text-decoration:none;
                              letter-spacing:0.5px;">
                      Go to Approvals Dashboard →
                    </a>
                  </td>
                </tr>
              </table>` : ''}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f9fc;padding:24px 40px;
                        border-top:1px solid #edf0f7;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:#9aa3b2;">
                This is your automated daily digest from Nitro.
                Sent every day at 8:00 AM.
              </p>
              <p style="margin:0;font-size:12px;color:#c0c8d8;">
                © ${new Date().getFullYear()} Nitro by TeamSuccesso. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

// ── Main digest function ─────────────────────────────────────────────────────

const sendAdminDailyDigest = async () => {
  try {
    console.log('[AdminDigest] Starting daily digest...');

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    // ── 1. New product requests (PENDING applications in last 24h) ──
    const { data: rawRequests } = await supabase
      .from('project_applications')
      .select(`
        id, created_at, status,
        participant_id,
        project_products ( name, product_value ),
        projects ( title )
      `)
      .eq('status', 'PENDING')
      .gte('created_at', since)
      .order('created_at', { ascending: false });

    // ── 2. Invoices uploaded (PENDING purchase_proofs in last 24h) ──
    const { data: rawInvoices } = await supabase
      .from('purchase_proofs')
      .select(`
        id, status,
        uploaded_at,
        participant_id,
        product_id,
        allocation_id
      `)
      .eq('status', 'PENDING')
      .gte('uploaded_at', since)
      .order('uploaded_at', { ascending: false });

    // ── 3. Reviews submitted (PENDING participant_reviews in last 24h) ──
    const { data: rawReviews } = await supabase
      .from('participant_reviews')
      .select(`
        id, created_at, status,
        participant_id, product_id, project_id,
        projects ( title )
      `)
      .eq('status', 'PENDING')
      .gte('created_at', since)
      .order('created_at', { ascending: false });

    // ── Enrich with participant profiles ──
    const allParticipantIds = [
      ...(rawRequests || []).map((r) => r.participant_id),
      ...(rawInvoices || []).map((r) => r.participant_id),
      ...(rawReviews || []).map((r) => r.participant_id),
    ].filter(Boolean);

    const uniqueParticipantIds = [...new Set(allParticipantIds)];
    let profileMap = new Map();
    if (uniqueParticipantIds.length) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', uniqueParticipantIds);
      profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    }

    // ── Enrich invoices with product names ──
    const invoiceProductIds = (rawInvoices || []).map((r) => r.product_id).filter(Boolean);
    let invoiceProductMap = new Map();
    if (invoiceProductIds.length) {
      const { data: prods } = await supabase
        .from('project_products')
        .select('id, name, project_id, project_products(id)');
      // Also get project titles via allocation
      const { data: prodsWithProject } = await supabase
        .from('project_products')
        .select('id, name')
        .in('id', invoiceProductIds);
      invoiceProductMap = new Map((prodsWithProject || []).map((p) => [p.id, p]));
    }

    // Get project titles for invoices via allocation
    const allocationIds = (rawInvoices || []).map((r) => r.allocation_id).filter(Boolean);
    let allocationProjectMap = new Map();
    if (allocationIds.length) {
      const { data: allocs } = await supabase
        .from('unit_allocations')
        .select('id, project_id, projects(title)')
        .in('id', allocationIds);
      allocationProjectMap = new Map(
        (allocs || []).map((a) => [a.id, a.projects?.title || null])
      );
    }

    // ── Format rows ──
    const requests = (rawRequests || []).map((r) => {
      const profile = profileMap.get(r.participant_id) || {};
      return {
        participant_name:  profile.full_name || null,
        participant_email: profile.email || null,
        product_name:      r.project_products?.name || '—',
        project_title:     r.projects?.title || '—',
        created_at:        r.created_at,
      };
    });

    const invoices = (rawInvoices || []).map((r) => {
      const profile = profileMap.get(r.participant_id) || {};
      const prod = invoiceProductMap.get(r.product_id);
      return {
        participant_name:  profile.full_name || null,
        participant_email: profile.email || null,
        product_name:      prod?.name || '—',
        project_title:     allocationProjectMap.get(r.allocation_id) || '—',
        uploaded_at:       r.uploaded_at,
        created_at:        r.uploaded_at,
      };
    });

    const reviews = (rawReviews || []).map((r) => {
      const profile = profileMap.get(r.participant_id) || {};
      return {
        participant_name:  profile.full_name || null,
        participant_email: profile.email || null,
        product_name:      '—', // enriched below if needed
        project_title:     r.projects?.title || '—',
        created_at:        r.created_at,
      };
    });

    // ── Get all admins ──
    const { data: admins } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('role', ['ADMIN', 'SUPER_ADMIN'])
      .eq('status', 'APPROVED');

    if (!admins?.length) {
      console.log('[AdminDigest] No admins found, skipping.');
      return;
    }

    const totalActivity = requests.length + invoices.length + reviews.length;
    console.log(`[AdminDigest] Activity: ${requests.length} requests, ${invoices.length} invoices, ${reviews.length} reviews`);

    // ── Send one email per admin ──
    for (const admin of admins) {
      if (!admin.email) continue;

      const subject = totalActivity === 0
        ? `✅ Daily Digest — No new activity today | Nitro`
        : `📋 Daily Digest — ${totalActivity} item${totalActivity !== 1 ? 's' : ''} need your attention | Nitro`;

      const html = buildAdminDigestHtml({
        adminName: admin.full_name || 'Admin',
        date: today,
        requests,
        invoices,
        reviews,
      });

      const result = await sendEmail({ to: admin.email, subject, html });
      if (result.success) {
        console.log(`[AdminDigest] Sent to ${admin.email}`);
      } else {
        console.error(`[AdminDigest] Failed to send to ${admin.email}:`, result.error?.message);
      }
    }

    console.log('[AdminDigest] Done.');
  } catch (err) {
    console.error('[AdminDigest] Job failed:', err?.message || err);
  }
};

// ── Schedule ─────────────────────────────────────────────────────────────────

const startAdminDigestJob = () => {
  // Runs every day at 8:00 AM server time
  cron.schedule('0 8 * * *', () => {
    console.log('[AdminDigest] Triggered at 8:00 AM');
    sendAdminDailyDigest();
  });

  console.log('[AdminDigest] Scheduled — runs daily at 8:00 AM');
};

module.exports = startAdminDigestJob;