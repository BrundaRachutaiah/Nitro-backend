/**
 * Nitro — Email Digest Queue
 *
 * Instead of sending one email per admin action, this module batches
 * email notifications so each participant receives at most ONE email
 * per "cycle" for each of the three digest types:
 *
 *   TYPE 1 — product_decision   : All product approvals + rejections in this cycle
 *   TYPE 2 — invoice_review     : All invoice/review approvals + rejections in this cycle
 *   TYPE 3 — payout_paid        : Handled separately in payout controller (already batched)
 *
 * How it works:
 *   • When an admin approves/rejects a product or invoice/review, we call
 *     scheduleDigest() instead of sendEmail() directly.
 *   • scheduleDigest() stores the event in memory and starts/resets a
 *     short debounce timer (FLUSH_DELAY_MS, 30 seconds).
 *   • When the timer fires, flushDigest() collects ALL pending events for
 *     that participant+type, builds ONE combined email, sends it, and clears
 *     the queue.
 *   • If multiple admin clicks happen within the debounce window (e.g.
 *     approving 5 products quickly), they all collapse into a single email.
 *   • The debounce resets on every new event, so a burst of actions always
 *     waits for the last one before sending.
 */

const { sendEmail } = require('./email.service');
const {
  productDecisionEmail,
  purchaseApprovedEmail,
  purchaseRejectedEmail,
  reviewApprovedEmail,
  reviewRejectedEmail,
} = require('./email.templates');
const env = require('../config/env');

// ── Configuration ────────────────────────────────────────────────────────────
// How long to wait (ms) after the LAST event before flushing the digest.
// 8 seconds is enough to catch rapid admin clicks while still feeling prompt.
const FLUSH_DELAY_MS = 30_000; // 30 seconds — best balance: catches rapid admin clicks, still feels prompt

// ── In-memory queue ──────────────────────────────────────────────────────────
// Structure:
//   queue[participantId][digestType] = {
//     timer:       NodeJS.Timeout,
//     participantEmail: string,
//     participantName:  string,
//     events:      DigestEvent[]
//   }
//
// DigestEvent for 'product_decision':
//   { status: 'APPROVED'|'REJECTED', productName, productValue, productUrl, brand, projectTitle }
//
// DigestEvent for 'invoice_review':
//   { kind: 'invoice'|'review', status: 'APPROVED'|'REJECTED', productName, projectTitle, reason? }

const queue = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

const frontendUrl = () => String(env.frontendUrl || 'http://localhost:5173').replace(/\/$/, '');

/**
 * Get or create the queue bucket for a participant + digest type.
 */
const getBucket = (participantId, digestType) => {
  if (!queue[participantId]) queue[participantId] = {};
  if (!queue[participantId][digestType]) {
    queue[participantId][digestType] = {
      timer: null,
      participantEmail: null,
      participantName: null,
      events: [],
    };
  }
  return queue[participantId][digestType];
};

/**
 * Clear and delete a bucket after flushing.
 */
const deleteBucket = (participantId, digestType) => {
  if (queue[participantId]) {
    delete queue[participantId][digestType];
    if (Object.keys(queue[participantId]).length === 0) {
      delete queue[participantId];
    }
  }
};

// ── Flush functions ──────────────────────────────────────────────────────────

/**
 * Build and send the product decision digest email.
 * Collects all approved and rejected products into ONE email.
 */
const flushProductDecision = async (participantId, bucket) => {
  const { participantEmail, participantName, events } = bucket;
  if (!participantEmail || !events.length) return;

  // Group by project/brand
  const approvedProducts = events
    .filter((e) => e.status === 'APPROVED')
    .map((e) => ({
      name: e.productName,
      product_value: e.productValue || null,
      product_url: e.productUrl || null,
      brand: e.brand || e.projectTitle || 'Project',
    }));

  const rejectedProducts = events
    .filter((e) => e.status === 'REJECTED')
    .map((e) => ({
      name: e.productName,
      brand: e.brand || e.projectTitle || 'Project',
    }));

  if (!approvedProducts.length && !rejectedProducts.length) return;

  // Derive a project title for the subject
  const allBrands = [...new Set(
    [...approvedProducts, ...rejectedProducts]
      .map((p) => String(p.brand || '').trim())
      .filter(Boolean)
  )];
  const projectLabel = allBrands.length === 1 ? allBrands[0] : 'Your Product Requests';

  const subject = approvedProducts.length > 0 && rejectedProducts.length === 0
    ? `🎉 Products Approved — Upload Your Invoice Now`
    : approvedProducts.length > 0
    ? `📋 Your Product Request Update — ${projectLabel}`
    : `📋 Product Request Update — ${projectLabel}`;

  const dashboardUrl = `${frontendUrl()}/participant/${participantId}/allocation/active`;

  try {
    await sendEmail({
      to: participantEmail,
      subject,
      html: productDecisionEmail(
        participantName,
        projectLabel,
        approvedProducts,
        rejectedProducts,
        dashboardUrl,
        dashboardUrl,
        dashboardUrl
      ),
    });
    console.log(`[EmailDigest] product_decision sent to ${participantEmail} — approved:${approvedProducts.length} rejected:${rejectedProducts.length}`);
  } catch (err) {
    console.error(`[EmailDigest] product_decision send failed for ${participantEmail}:`, err?.message || err);
  }
};

/**
 * Build and send the invoice + review digest email.
 * Collects all invoice/review approvals AND rejections into ONE email.
 */
const flushInvoiceReview = async (participantId, bucket) => {
  const { participantEmail, participantName, events } = bucket;
  if (!participantEmail || !events.length) return;

  // Separate by kind and status
  const invoiceApproved = events.filter((e) => e.kind === 'invoice' && e.status === 'APPROVED');
  const invoiceRejected = events.filter((e) => e.kind === 'invoice' && e.status === 'REJECTED');
  const reviewApproved  = events.filter((e) => e.kind === 'review'  && e.status === 'APPROVED');
  const reviewRejected  = events.filter((e) => e.kind === 'review'  && e.status === 'REJECTED');

  if (!events.length) return;

  // Derive project names
  const allProjects = [...new Set(events.map((e) => e.projectTitle).filter(Boolean))];
  const projectLabel = allProjects.length === 1 ? allProjects[0] : null;

  const dashboardUrl = `${frontendUrl()}/participant/${participantId}/allocation/active`;

  // Determine subject based on what's in the digest
  let subject;
  if (reviewApproved.length > 0 && invoiceRejected.length === 0 && reviewRejected.length === 0) {
    subject = `🎊 Review Approved — Your Payout Is Unlocked!`;
  } else if (invoiceApproved.length > 0 && reviewApproved.length === 0 && invoiceRejected.length === 0 && reviewRejected.length === 0) {
    subject = `✅ Invoice Approved — Submit Your Review`;
  } else {
    subject = `📋 Your Submission Update${projectLabel ? ` — ${projectLabel}` : ''}`;
  }

  // Build a combined HTML email using the existing templates as building blocks
  // We compose sections from each approved/rejected template, merging into one send
  try {
    const html = buildInvoiceReviewDigestHtml({
      participantName,
      participantId,
      projectLabel,
      invoiceApproved,
      invoiceRejected,
      reviewApproved,
      reviewRejected,
      dashboardUrl,
    });

    await sendEmail({ to: participantEmail, subject, html });
    console.log(
      `[EmailDigest] invoice_review sent to ${participantEmail} — ` +
      `inv_ok:${invoiceApproved.length} inv_rej:${invoiceRejected.length} ` +
      `rev_ok:${reviewApproved.length} rev_rej:${reviewRejected.length}`
    );
  } catch (err) {
    console.error(`[EmailDigest] invoice_review send failed for ${participantEmail}:`, err?.message || err);
  }
};

/**
 * Build a combined invoice+review digest HTML email.
 * Reuses the email.templates wrap/layout by constructing inline HTML directly.
 */
const buildInvoiceReviewDigestHtml = ({
  participantName,
  participantId,
  projectLabel,
  invoiceApproved,
  invoiceRejected,
  reviewApproved,
  reviewRejected,
  dashboardUrl,
}) => {
  const name = participantName || 'Valued Participant';
  const fmt = (n) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n || 0));

  // ── Sections ──────────────────────────────────────────────────────────────

  // Invoice Approved
  const invoiceApprovedSection = invoiceApproved.length ? `
    <div style="margin:24px 0 0;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">
        ✅ Invoice${invoiceApproved.length > 1 ? 's' : ''} Approved (${invoiceApproved.length})
      </p>
      <p style="margin:0 0 14px;font-size:13px;color:#6c8f72;">
        Your purchase proof has been verified. Please submit your product review to unlock your payout.
      </p>
      ${invoiceApproved.map((e) => `
        <table cellpadding="0" cellspacing="0" border="0" width="100%"
               style="border:1.5px solid #c3e6cb;border-radius:10px;overflow:hidden;
                      margin-bottom:10px;background:#f6fff8;">
          <tr>
            <td style="padding:14px 16px;vertical-align:middle;">
              <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#1a1a2e;">${e.productName || 'Product'}</p>
              ${e.projectTitle ? `<p style="margin:0 0 6px;font-size:12px;color:#9aa3b2;">Campaign: ${e.projectTitle}</p>` : ''}
              <span style="display:inline-block;padding:3px 10px;border-radius:20px;
                           font-size:10px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#d4edda;color:#27ae60;">
                ✓ Invoice Verified
              </span>
            </td>
          </tr>
        </table>`).join('')}
      <div style="background:#eafaf1;border:1.5px solid #a9dfbf;border-radius:10px;
                  padding:14px 18px;margin-top:12px;">
        <p style="margin:0 0 10px;font-size:13px;color:#2e7d4f;line-height:1.6;">
          <strong>Next step:</strong> Go to your Tasks page and submit a genuine product review to complete your task and unlock your payout.
        </p>
        <a href="${dashboardUrl}" target="_blank"
           style="display:inline-block;padding:10px 22px;font-size:13px;font-weight:700;
                  color:#fff;background:linear-gradient(135deg,#27ae60,#1e8449);
                  border-radius:7px;text-decoration:none;">
          ✍️ Submit Review →
        </a>
      </div>
    </div>` : '';

  // Invoice Rejected
  const invoiceRejectedSection = invoiceRejected.length ? `
    <div style="margin:24px 0 0;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">
        ⚠️ Invoice${invoiceRejected.length > 1 ? 's' : ''} Require Attention (${invoiceRejected.length})
      </p>
      <p style="margin:0 0 14px;font-size:13px;color:#e07070;">
        The following purchase proof${invoiceRejected.length > 1 ? 's need' : ' needs'} to be re-uploaded.
      </p>
      ${invoiceRejected.map((e) => `
        <table cellpadding="0" cellspacing="0" border="0" width="100%"
               style="border:1.5px solid #f5c6cb;border-radius:10px;overflow:hidden;
                      margin-bottom:10px;background:#fff5f6;">
          <tr>
            <td style="padding:14px 16px;vertical-align:middle;">
              <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#1a1a2e;">${e.productName || 'Product'}</p>
              ${e.projectTitle ? `<p style="margin:0 0 6px;font-size:12px;color:#9aa3b2;">Campaign: ${e.projectTitle}</p>` : ''}
              ${e.reason ? `<p style="margin:0 0 8px;font-size:12px;color:#c0392b;">Reason: ${e.reason}</p>` : ''}
              <span style="display:inline-block;padding:3px 10px;border-radius:20px;
                           font-size:10px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#f8d7da;color:#c0392b;">
                ✕ Invoice Rejected
              </span>
            </td>
          </tr>
        </table>`).join('')}
      <div style="background:#fff0f0;border:1.5px solid #f5c6cb;border-radius:10px;
                  padding:14px 18px;margin-top:12px;">
        <p style="margin:0 0 10px;font-size:13px;color:#c0392b;line-height:1.6;">
          Please re-upload a clear, valid purchase invoice. Ensure the invoice includes the product name, price, and purchase date.
        </p>
        <a href="${dashboardUrl}" target="_blank"
           style="display:inline-block;padding:10px 22px;font-size:13px;font-weight:700;
                  color:#fff;background:linear-gradient(135deg,#e94560,#c0392b);
                  border-radius:7px;text-decoration:none;">
          📤 Re-upload Invoice →
        </a>
      </div>
    </div>` : '';

  // Review Approved
  const reviewApprovedSection = reviewApproved.length ? `
    <div style="margin:24px 0 0;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">
        🎊 Review${reviewApproved.length > 1 ? 's' : ''} Approved — Payout Unlocked! (${reviewApproved.length})
      </p>
      <p style="margin:0 0 14px;font-size:13px;color:#6c8f72;">
        Your review has been accepted. Your payout is now eligible and will be processed in the next cycle.
      </p>
      ${reviewApproved.map((e) => `
        <table cellpadding="0" cellspacing="0" border="0" width="100%"
               style="border:1.5px solid #c3e6cb;border-radius:10px;overflow:hidden;
                      margin-bottom:10px;background:#f6fff8;">
          <tr>
            <td style="padding:14px 16px;vertical-align:middle;">
              <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#1a1a2e;">${e.productName || 'Product'}</p>
              ${e.projectTitle ? `<p style="margin:0 0 6px;font-size:12px;color:#9aa3b2;">Campaign: ${e.projectTitle}</p>` : ''}
              ${e.payoutAmount ? `<p style="margin:0 0 6px;font-size:13px;color:#1e8449;font-weight:700;">Eligible Payout: ${fmt(e.payoutAmount)}</p>` : ''}
              <span style="display:inline-block;padding:3px 10px;border-radius:20px;
                           font-size:10px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#d4edda;color:#27ae60;">
                ✓ Review Accepted
              </span>
            </td>
          </tr>
        </table>`).join('')}
    </div>` : '';

  // Review Rejected
  const reviewRejectedSection = reviewRejected.length ? `
    <div style="margin:24px 0 0;">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">
        📝 Review${reviewRejected.length > 1 ? 's' : ''} Need Revision (${reviewRejected.length})
      </p>
      <p style="margin:0 0 14px;font-size:13px;color:#e07070;">
        The following review${reviewRejected.length > 1 ? 's were' : ' was'} not approved. Please revise and resubmit.
      </p>
      ${reviewRejected.map((e) => `
        <table cellpadding="0" cellspacing="0" border="0" width="100%"
               style="border:1.5px solid #f5c6cb;border-radius:10px;overflow:hidden;
                      margin-bottom:10px;background:#fff5f6;">
          <tr>
            <td style="padding:14px 16px;vertical-align:middle;">
              <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#1a1a2e;">${e.productName || 'Product'}</p>
              ${e.projectTitle ? `<p style="margin:0 0 6px;font-size:12px;color:#9aa3b2;">Campaign: ${e.projectTitle}</p>` : ''}
              ${e.reason ? `<p style="margin:0 0 8px;font-size:12px;color:#c0392b;">Feedback: ${e.reason}</p>` : ''}
              <span style="display:inline-block;padding:3px 10px;border-radius:20px;
                           font-size:10px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#f8d7da;color:#c0392b;">
                ✕ Review Rejected
              </span>
            </td>
          </tr>
        </table>`).join('')}
      <div style="background:#fff8f0;border:1.5px solid #fad7a0;border-radius:10px;
                  padding:14px 18px;margin-top:12px;">
        <p style="margin:0 0 10px;font-size:13px;color:#7d6608;line-height:1.6;">
          Tips for a better review: Share your genuine experience, mention specific features, ensure it's original and meets the minimum word count.
        </p>
        <a href="${dashboardUrl}" target="_blank"
           style="display:inline-block;padding:10px 22px;font-size:13px;font-weight:700;
                  color:#fff;background:linear-gradient(135deg,#e67e22,#ca6f1e);
                  border-radius:7px;text-decoration:none;">
          ✍️ Revise & Resubmit →
        </a>
      </div>
    </div>` : '';

  const body = `
    <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#1a1a2e;">
      Your Submission Update
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#9aa3b2;font-weight:400;">
      ${projectLabel ? `Activity summary for <strong>${projectLabel}</strong>` : 'Activity summary from Nitro'}
    </p>
    <hr style="border:none;border-top:1px solid #edf0f7;margin:28px 0;" />
    <p style="margin:0 0 20px;font-size:16px;color:#3d4451;">
      Hello, <strong style="color:#1a1a2e;">${name}</strong> 👋
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#4a5568;">
      Here's a summary of all recent activity on your submissions.
    </p>
    ${invoiceApprovedSection}
    ${invoiceRejectedSection}
    ${reviewApprovedSection}
    ${reviewRejectedSection}
    <hr style="border:none;border-top:1px solid #edf0f7;margin:28px 0;" />
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Warm regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nitro</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f9;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;
                      overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%);
                        padding:36px 40px;text-align:center;">
              <span style="font-size:28px;font-weight:800;color:#ffffff;
                           letter-spacing:3px;text-transform:uppercase;">NITRO</span>
              <div style="width:40px;height:3px;background:#e94560;margin:8px auto 0;border-radius:2px;"></div>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="background:#f8f9fc;padding:24px 40px;border-top:1px solid #edf0f7;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;color:#9aa3b2;">
                This is an automated message from Nitro. Please do not reply to this email.
              </p>
              <p style="margin:0;font-size:12px;color:#c0c8d8;">
                © ${new Date().getFullYear()} Nitro. All rights reserved.
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Schedule a product_decision digest event.
 *
 * @param {object} opts
 * @param {string}  opts.participantId
 * @param {string}  opts.participantEmail
 * @param {string}  opts.participantName
 * @param {'APPROVED'|'REJECTED'} opts.status
 * @param {string}  opts.productName
 * @param {string}  [opts.productValue]
 * @param {string}  [opts.productUrl]
 * @param {string}  [opts.brand]
 * @param {string}  [opts.projectTitle]
 */
const scheduleProductDecision = (opts) => {
  const { participantId, participantEmail, participantName, ...event } = opts;
  if (!participantId || !participantEmail) return;

  const bucket = getBucket(participantId, 'product_decision');
  bucket.participantEmail = participantEmail;
  bucket.participantName  = participantName || participantEmail;
  bucket.events.push(event);

  // Reset the debounce timer
  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(async () => {
    const snapshot = { ...bucket, events: [...bucket.events] };
    deleteBucket(participantId, 'product_decision');
    await flushProductDecision(participantId, snapshot);
  }, FLUSH_DELAY_MS);
};

/**
 * Schedule an invoice_review digest event.
 *
 * @param {object} opts
 * @param {string}  opts.participantId
 * @param {string}  opts.participantEmail
 * @param {string}  opts.participantName
 * @param {'invoice'|'review'} opts.kind
 * @param {'APPROVED'|'REJECTED'} opts.status
 * @param {string}  [opts.productName]
 * @param {string}  [opts.projectTitle]
 * @param {string}  [opts.reason]
 * @param {number}  [opts.payoutAmount]   - Only for review_approved
 */
const scheduleInvoiceReview = (opts) => {
  const { participantId, participantEmail, participantName, ...event } = opts;
  if (!participantId || !participantEmail) return;

  const bucket = getBucket(participantId, 'invoice_review');
  bucket.participantEmail = participantEmail;
  bucket.participantName  = participantName || participantEmail;
  bucket.events.push(event);

  // Reset the debounce timer
  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(async () => {
    const snapshot = { ...bucket, events: [...bucket.events] };
    deleteBucket(participantId, 'invoice_review');
    await flushInvoiceReview(participantId, snapshot);
  }, FLUSH_DELAY_MS);
};

/**
 * Force-flush ALL pending digests immediately (useful for graceful shutdown).
 */
const flushAll = async () => {
  const promises = [];
  for (const participantId of Object.keys(queue)) {
    for (const digestType of Object.keys(queue[participantId] || {})) {
      const bucket = queue[participantId][digestType];
      if (!bucket) continue;
      if (bucket.timer) clearTimeout(bucket.timer);
      const snapshot = { ...bucket, events: [...bucket.events] };
      deleteBucket(participantId, digestType);
      if (digestType === 'product_decision') {
        promises.push(flushProductDecision(participantId, snapshot));
      } else if (digestType === 'invoice_review') {
        promises.push(flushInvoiceReview(participantId, snapshot));
      }
    }
  }
  await Promise.allSettled(promises);
};

module.exports = {
  scheduleProductDecision,
  scheduleInvoiceReview,
  flushAll,
  // Exposed for testing
  _queue: queue,
};