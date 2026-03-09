/**
 * Nitro — HTML Email Templates
 * All emails use inline styles for maximum email-client compatibility.
 */

// ─────────────────────────────────────────────
// Shared layout wrapper
// ─────────────────────────────────────────────
const wrap = (content) => `
<!DOCTYPE html>
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

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%);
                        padding:36px 40px;text-align:center;">
              <span style="font-size:28px;font-weight:800;color:#ffffff;
                           letter-spacing:3px;text-transform:uppercase;">NITRO</span>
              <div style="width:40px;height:3px;background:#e94560;margin:8px auto 0;border-radius:2px;"></div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
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
</html>
`;

// ─────────────────────────────────────────────
// Helper components
// ─────────────────────────────────────────────
const heading = (text) =>
  `<h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#1a1a2e;">${text}</h1>`;

const subheading = (text) =>
  `<p style="margin:0 0 24px;font-size:15px;color:#9aa3b2;font-weight:400;">${text}</p>`;

const divider = () =>
  `<hr style="border:none;border-top:1px solid #edf0f7;margin:28px 0;" />`;

const greeting = (name) =>
  `<p style="margin:0 0 20px;font-size:16px;color:#3d4451;">
    Hello, <strong style="color:#1a1a2e;">${name || 'Valued Participant'}</strong> 👋
  </p>`;

const bodyText = (text) =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#4a5568;">${text}</p>`;

const ctaButton = (label, url) =>
  `<table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
    <tr>
      <td style="background:linear-gradient(135deg,#e94560,#c0392b);border-radius:8px;">
        <a href="${url}" target="_blank"
           style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;
                  color:#ffffff;text-decoration:none;letter-spacing:0.5px;">
          ${label} →
        </a>
      </td>
    </tr>
  </table>`;

const infoBox = (items) => {
  const rows = items
    .map(
      ({ label, value }) => `
        <tr>
          <td style="padding:10px 16px;font-size:13px;color:#9aa3b2;font-weight:600;
                     text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;width:40%;">
            ${label}
          </td>
          <td style="padding:10px 16px;font-size:14px;color:#1a1a2e;font-weight:600;">
            ${value}
          </td>
        </tr>`
    )
    .join('');
  return `
    <table cellpadding="0" cellspacing="0" border="0" width="100%"
           style="background:#f8f9fc;border-radius:8px;border:1px solid #edf0f7;
                  margin:20px 0;overflow:hidden;">
      <tbody>${rows}</tbody>
    </table>`;
};

const statusBadge = (label, color) =>
  `<span style="display:inline-block;padding:4px 14px;border-radius:20px;
                font-size:12px;font-weight:700;letter-spacing:0.5px;
                text-transform:uppercase;background:${color}20;color:${color};">
    ${label}
  </span>`;

// ─────────────────────────────────────────────
// 1. ACCOUNT APPROVED — Welcome email
// ─────────────────────────────────────────────
const approvalEmail = (name, loginUrl = 'https://nitro.com/login') =>
  wrap(`
    ${heading('Welcome to Nitro! 🎉')}
    ${subheading('Your account has been approved by our team')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `We're thrilled to let you know that your Nitro account has been reviewed and <strong>officially approved</strong>. 
       You're now part of an exclusive community of participants who get access to top products and exciting projects.`
    )}
    ${bodyText(
      `Here's what you can do next:`
    )}
    <ul style="margin:0 0 20px 0;padding-left:20px;">
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Browse available projects and express your interest</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Apply for product allocations that match your profile</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Track your progress and payouts from your dashboard</li>
    </ul>
    ${ctaButton('Log In & Get Started', loginUrl)}
    ${divider()}
    ${bodyText(
      `If you have any questions or need assistance getting started, our support team is always here to help. 
       We look forward to a great collaboration!`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Warm regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

// ─────────────────────────────────────────────
// 2. ACCOUNT REJECTED
// ─────────────────────────────────────────────
const rejectionEmail = (name, reason = '') =>
  wrap(`
    ${heading('Application Update')}
    ${subheading('Regarding your Nitro account request')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `Thank you for your interest in joining Nitro. After a careful review of your application, 
       we regret to inform you that we are <strong>unable to approve your account</strong> at this time.`
    )}
    ${reason
      ? infoBox([{ label: 'Reason', value: reason }])
      : ''}
    ${bodyText(
      `Please don't be discouraged. You're welcome to reapply once the concerns above have been addressed, 
       or reach out to our team if you believe this decision was made in error.`
    )}
    ${divider()}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

// ─────────────────────────────────────────────
// 3. UNIT ALLOCATION — Product reserved
// ─────────────────────────────────────────────
const allocationEmail = (
  name,
  projectName,
  expiryDate,
  products = [],   // array of { name, image_url, product_url, product_value }
  dashboardUrl = 'https://nitro.com/dashboard'
) => {
  const productCards = products.length
    ? `
      <p style="margin:24px 0 12px;font-size:15px;font-weight:700;color:#1a1a2e;">
        Your Allocated Product${products.length > 1 ? 's' : ''}:
      </p>
      ${products
        .map(
          (p) => `
          <table cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border:1px solid #edf0f7;border-radius:10px;overflow:hidden;
                        margin-bottom:16px;background:#ffffff;">
            <tr>
              ${
                p.image_url
                  ? `<td width="110" style="padding:16px;vertical-align:middle;">
                       <img src="${p.image_url}" width="90" height="90" alt="${p.name}"
                            style="border-radius:8px;object-fit:cover;display:block;" />
                     </td>`
                  : ''
              }
              <td style="padding:16px;vertical-align:middle;">
                <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">${p.name}</p>
                ${p.product_value ? `<p style="margin:0 0 10px;font-size:13px;color:#9aa3b2;">Value: ₹${Number(p.product_value).toLocaleString('en-IN')}</p>` : ''}
                ${
                  p.product_url
                    ? `<a href="${p.product_url}" target="_blank"
                          style="display:inline-block;padding:7px 18px;font-size:13px;font-weight:600;
                                 color:#e94560;border:1.5px solid #e94560;border-radius:6px;
                                 text-decoration:none;">
                          🛒 Purchase Now
                       </a>`
                    : ''
                }
              </td>
            </tr>
          </table>`
        )
        .join('')}`
    : '';

  return wrap(`
    ${heading('Your Product Has Been Reserved!')}
    ${subheading(`Allocation confirmed for project: ${projectName}`)}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `Great news! A unit has been <strong>successfully reserved</strong> for you as part of the 
       <strong>${projectName}</strong> project. Your slot is now held — please act promptly to secure it.`
    )}
    ${infoBox([
      { label: 'Project', value: projectName },
      { label: 'Reservation Expires', value: new Date(expiryDate).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' }) }
    ])}
    ${productCards}
    ${bodyText(
      `<strong>Important:</strong> To confirm your allocation, you must upload a valid purchase invoice/proof 
       before the expiry date shown above. Failure to do so will release your slot back to the queue.`
    )}
    ${ctaButton('Upload Purchase Proof', dashboardUrl)}
    ${divider()}
    ${bodyText(`If you have any questions about the purchase process, feel free to reach out to our support team.`)}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Best of luck,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 4. PURCHASE / INVOICE APPROVED
// ─────────────────────────────────────────────
const purchaseApprovedEmail = (
  name,
  projectName,
  products = [],
  nextStepUrl = 'https://nitro.com/dashboard'
) => {
  const productList = products.length
    ? `
      <p style="margin:24px 0 12px;font-size:15px;font-weight:700;color:#1a1a2e;">Approved Products:</p>
      ${products
        .map(
          (p) => `
          <table cellpadding="0" cellspacing="0" border="0" width="100%"
                 style="border:1px solid #d4edda;border-radius:10px;overflow:hidden;
                        margin-bottom:12px;background:#f6fff8;">
            <tr>
              ${
                p.image_url
                  ? `<td width="100" style="padding:14px;vertical-align:middle;">
                       <img src="${p.image_url}" width="80" height="80" alt="${p.name}"
                            style="border-radius:8px;object-fit:cover;display:block;" />
                     </td>`
                  : ''
              }
              <td style="padding:14px;vertical-align:middle;">
                <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">${p.name}</p>
                ${p.product_value ? `<p style="margin:0 0 8px;font-size:13px;color:#9aa3b2;">Value: ₹${Number(p.product_value).toLocaleString('en-IN')}</p>` : ''}
                ${statusBadge('Approved ✓', '#27ae60')}
              </td>
            </tr>
          </table>`
        )
        .join('')}`
    : '';

  return wrap(`
    ${heading('Invoice Approved ✅')}
    ${subheading('Your purchase proof has been successfully verified')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `Excellent news! Our team has reviewed and <strong>approved your purchase invoice</strong> for 
       the <strong>${projectName || 'assigned project'}</strong>. Your submission is now verified and 
       your participation is confirmed.`
    )}
    ${projectName ? infoBox([{ label: 'Project', value: projectName }]) : ''}
    ${productList}
    ${bodyText(
      `Your next step is to submit your <strong>product review</strong>. A thoughtful, detailed review 
       ensures you remain eligible for your payout — so take your time and share your genuine experience!`
    )}
    ${ctaButton('Submit Your Review', nextStepUrl)}
    ${divider()}
    ${bodyText(
      `Thank you for your continued participation. We truly value the effort you put in — keep it up! 🙌`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Warm regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 5. PURCHASE / INVOICE REJECTED
// ─────────────────────────────────────────────
const purchaseRejectedEmail = (name, projectName, reason = '', reuploadUrl = 'https://nitro.com/dashboard') =>
  wrap(`
    ${heading('Invoice Requires Attention ⚠️')}
    ${subheading('Action needed: Please re-upload your purchase proof')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `We regret to inform you that your purchase invoice for <strong>${projectName || 'your project'}</strong> 
       could not be approved. Our team found an issue that needs to be resolved before we can proceed.`
    )}
    ${reason
      ? infoBox([
          { label: 'Project', value: projectName || '—' },
          { label: 'Reason', value: reason }
        ])
      : projectName
      ? infoBox([{ label: 'Project', value: projectName }])
      : ''}
    ${bodyText(
      `Please ensure your re-uploaded invoice meets the following requirements:`
    )}
    <ul style="margin:0 0 20px 0;padding-left:20px;">
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">The invoice must be clear, complete, and legible</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">It should include the product name, price, and date of purchase</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">The buyer's name should match your registered profile</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Accepted formats: PDF, JPG, or PNG (max 5 MB)</li>
    </ul>
    ${ctaButton('Re-upload Invoice', reuploadUrl)}
    ${divider()}
    ${bodyText(
      `If you believe this rejection was made in error or need further assistance, please contact our support team. 
       We're here to help you get back on track as quickly as possible.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

// ─────────────────────────────────────────────
// 6. REVIEW APPROVED — Payout eligible
// ─────────────────────────────────────────────
const reviewApprovedEmail = (name, projectName, payoutAmount, dashboardUrl = 'https://nitro.com/dashboard') =>
  wrap(`
    ${heading('Review Approved — Payout Unlocked! 🎊')}
    ${subheading('Your review has been accepted and your earnings are now eligible')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `Fantastic work! Your review for <strong>${projectName || 'your project'}</strong> has been 
       evaluated and <strong>officially approved</strong> by our quality team. You've completed 
       all the required steps — your payout is now unlocked and pending processing.`
    )}
    ${infoBox([
      ...(projectName ? [{ label: 'Project', value: projectName }] : []),
      ...(payoutAmount ? [{ label: 'Eligible Payout', value: `₹${Number(payoutAmount).toLocaleString('en-IN')}` }] : []),
      { label: 'Status', value: '✅ Payout Eligible' }
    ])}
    ${bodyText(
      `Your earnings will be processed in the next scheduled payout cycle. 
       You can monitor the status of your payment directly from your dashboard.`
    )}
    ${ctaButton('View My Dashboard', dashboardUrl)}
    ${divider()}
    ${bodyText(
      `We truly appreciate the quality and effort you brought to this review. 
       Your feedback helps make Nitro better for everyone. Thank you for being a valued part of our community! 🙏`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">With appreciation,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

// ─────────────────────────────────────────────
// 7. REVIEW REJECTED
// ─────────────────────────────────────────────
const reviewRejectedEmail = (name, projectName, reason = '', resubmitUrl = 'https://nitro.com/dashboard') =>
  wrap(`
    ${heading('Review Needs Revision 📝')}
    ${subheading('Please update and resubmit your review')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `Thank you for submitting your review for <strong>${projectName || 'your project'}</strong>. 
       After a thorough evaluation, our quality team was <strong>unable to approve it</strong> in its 
       current form. We'd love to see a revised version from you!`
    )}
    ${reason
      ? infoBox([
          { label: 'Project', value: projectName || '—' },
          { label: 'Feedback', value: reason }
        ])
      : projectName
      ? infoBox([{ label: 'Project', value: projectName }])
      : ''}
    ${bodyText(`To help you craft a stronger review, here are a few tips:`)}
    <ul style="margin:0 0 20px 0;padding-left:20px;">
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Share your genuine, first-hand experience with the product</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Mention specific features, pros and cons in detail</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Ensure your review is original and meets the minimum word count</li>
      <li style="font-size:15px;line-height:1.9;color:#4a5568;">Avoid promotional language or generic statements</li>
    </ul>
    ${ctaButton('Update & Resubmit Review', resubmitUrl)}
    ${divider()}
    ${bodyText(
      `You still have an opportunity to get this right — we encourage you to revise and resubmit at your earliest convenience. 
       Our team is rooting for you!`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

// ─────────────────────────────────────────────
// 8. ALLOCATION REMINDER — Expiry approaching
// ─────────────────────────────────────────────
/**
 * @param {string}  name          - Participant name
 * @param {string}  projectName   - Project / brand name
 * @param {number}  dayNumber     - Which reminder day (10, 15, 18, 19)
 * @param {number}  daysLeft      - Days remaining until expiry
 * @param {string}  expiryDate    - ISO expiry timestamp
 * @param {Array}   products      - [{ name, image_url, product_url, product_value }]
 * @param {string}  dashboardUrl  - CTA link
 */
const allocationReminderEmail = ({
  name,
  projectName,
  dayNumber,
  daysLeft,
  expiryDate,
  products = [],
  dashboardUrl = 'https://nitro.com/dashboard'
}) => {
  // ── Urgency config per reminder day ──────────────────────────────────────
  const isLastWarning = dayNumber === 19;
  const isCritical    = dayNumber === 18 || dayNumber === 19;

  const headingText = isLastWarning
    ? '🚨 Final Warning: 1 Day Left!'
    : isCritical
    ? `⚠️ ${daysLeft} Day${daysLeft === 1 ? '' : 's'} Left — Action Required`
    : `⏰ Reminder: ${daysLeft} Days Remaining`;

  const subText = isLastWarning
    ? `Your reservation will be <strong>cancelled tomorrow</strong> if no invoice is submitted`
    : isCritical
    ? `Critical deadline approaching for <strong>${projectName}</strong>`
    : `Your product reservation for <strong>${projectName}</strong> needs attention`;

  const urgencyMessage = isLastWarning
    ? `<strong style="color:#c0392b;">This is your final notice.</strong> Your reservation for <strong>${projectName}</strong> expires in less than 24 hours. If a valid purchase invoice is not uploaded by the deadline, your slot will be <strong>permanently cancelled</strong> and the budget will be reallocated to another participant. This action cannot be undone.`
    : isCritical
    ? `Your time is running short. Your reserved slot for <strong>${projectName}</strong> expires in just <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>. Please upload your purchase invoice immediately to secure your participation and avoid losing this opportunity.`
    : `This is a scheduled reminder that your reserved product slot for <strong>${projectName}</strong> will expire in <strong>${daysLeft} day${daysLeft === 1 ? '' : 's'}</strong>. To keep your allocation active, please purchase your assigned product and upload the invoice before the deadline shown below.`;

  // ── Progress bar (visual day indicator out of 20) ─────────────────────────
  const progressPct   = Math.round((dayNumber / 20) * 100);
  const barColor      = dayNumber >= 19 ? '#c0392b' : dayNumber >= 18 ? '#e74c3c' : dayNumber >= 15 ? '#e67e22' : '#f39c12';
  const progressBar   = `
    <div style="margin:20px 0;">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="font-size:12px;color:#9aa3b2;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">
          Day ${dayNumber} of 20
        </span>
        <span style="font-size:12px;font-weight:700;color:${barColor};">
          ${daysLeft} day${daysLeft === 1 ? '' : 's'} left
        </span>
      </div>
      <div style="background:#edf0f7;border-radius:20px;height:8px;overflow:hidden;">
        <div style="background:${barColor};height:8px;border-radius:20px;width:${progressPct}%;
                    transition:width 0.3s ease;"></div>
      </div>
    </div>`;

  // ── Product cards with purchase links ─────────────────────────────────────
  const productCards = products.length ? `
    <p style="margin:28px 0 12px;font-size:15px;font-weight:700;color:#1a1a2e;">
      Your Reserved Product${products.length > 1 ? 's' : ''}:
    </p>
    ${products.map((p) => `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1.5px solid #edf0f7;border-radius:12px;overflow:hidden;
                    margin-bottom:14px;background:#ffffff;">
        <tr>
          ${p.image_url
            ? `<td width="110" style="padding:16px 12px 16px 16px;vertical-align:middle;">
                 <img src="${p.image_url}" width="82" height="82" alt="${p.name}"
                      style="border-radius:8px;object-fit:cover;display:block;border:1px solid #edf0f7;" />
               </td>`
            : ''}
          <td style="padding:16px;vertical-align:middle;">
            <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a2e;">${p.name}</p>
            ${p.product_value
              ? `<p style="margin:0 0 10px;font-size:13px;color:#9aa3b2;">
                   Value: <strong style="color:#1a1a2e;">₹${Number(p.product_value).toLocaleString('en-IN')}</strong>
                 </p>`
              : ''}
            ${p.product_url
              ? `<a href="${p.product_url}" target="_blank"
                    style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;
                           color:#ffffff;background:linear-gradient(135deg,#e94560,#c0392b);
                           border-radius:6px;text-decoration:none;letter-spacing:0.3px;">
                   🛒 Purchase Now →
                 </a>`
              : ''}
          </td>
        </tr>
      </table>`).join('')}` : '';

  // ── What happens if you miss the deadline ─────────────────────────────────
  const consequenceBox = isLastWarning ? `
    <div style="background:#fff0f0;border:1.5px solid #e74c3c;border-radius:10px;
                padding:18px 20px;margin:24px 0;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#c0392b;">
        ⛔ What happens if you miss the deadline:
      </p>
      <ul style="margin:0;padding-left:18px;">
        <li style="font-size:14px;line-height:1.8;color:#922b21;">Your reservation will be permanently cancelled</li>
        <li style="font-size:14px;line-height:1.8;color:#922b21;">The reserved budget will be released back to the project pool</li>
        <li style="font-size:14px;line-height:1.8;color:#922b21;">Another participant may be approved in your place</li>
      </ul>
    </div>` : '';

  return wrap(`
    ${heading(headingText)}
    <p style="margin:0 0 24px;font-size:15px;color:#9aa3b2;font-weight:400;">${subText}</p>
    ${divider()}
    ${greeting(name)}
    ${bodyText(urgencyMessage)}
    ${progressBar}
    ${infoBox([
      { label: 'Project',     value: projectName },
      { label: 'Deadline',    value: new Date(expiryDate).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' }) },
      { label: 'Days Left',   value: `${isLastWarning ? '🚨' : isCritical ? '⚠️' : '📅'} ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining` }
    ])}
    ${productCards}
    ${consequenceBox}
    ${ctaButton('Upload Invoice Now', dashboardUrl)}
    ${divider()}
    ${bodyText(
      `If you have already uploaded your purchase proof, kindly disregard this reminder — your submission is being reviewed. For any concerns or technical difficulties, please reach out to our support team at your earliest convenience.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">
      ${isLastWarning ? 'Time is critical,' : 'Warm regards,'}<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 9. ALLOCATION EXPIRED
// ─────────────────────────────────────────────
/**
 * @param {string} name         - Participant name
 * @param {string} projectName  - Project / brand name
 * @param {Array}  products     - [{ name, image_url, product_value }]
 * @param {string} reapplyUrl   - Explore projects CTA
 */
const allocationExpiredEmail = ({ name, projectName, products = [], reapplyUrl = 'https://nitro.com/projects' }) => {
  const productList = products.length ? `
    <p style="margin:24px 0 12px;font-size:15px;font-weight:700;color:#1a1a2e;">
      Cancelled Product${products.length > 1 ? 's' : ''}:
    </p>
    ${products.map((p) => `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1.5px solid #f5c6cb;border-radius:10px;overflow:hidden;
                    margin-bottom:12px;background:#fff5f6;opacity:0.9;">
        <tr>
          ${p.image_url
            ? `<td width="90" style="padding:14px 10px 14px 14px;vertical-align:middle;">
                 <img src="${p.image_url}" width="62" height="62" alt="${p.name}"
                      style="border-radius:6px;object-fit:cover;display:block;
                             filter:grayscale(40%);border:1px solid #f5c6cb;" />
               </td>`
            : ''}
          <td style="padding:14px;vertical-align:middle;">
            <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#1a1a2e;">${p.name}</p>
            ${p.product_value
              ? `<p style="margin:0 0 8px;font-size:12px;color:#9aa3b2;">
                   Value: ₹${Number(p.product_value).toLocaleString('en-IN')}
                 </p>`
              : ''}
            <span style="display:inline-block;padding:3px 12px;border-radius:20px;
                         font-size:11px;font-weight:700;letter-spacing:0.5px;
                         text-transform:uppercase;background:#f8d7da;color:#c0392b;">
              ✕ Reservation Cancelled
            </span>
          </td>
        </tr>
      </table>`).join('')}` : '';

  return wrap(`
    ${heading('Reservation Cancelled ❌')}
    ${subheading(`Your product slot for ${projectName} has been released`)}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `We regret to inform you that your product reservation for <strong>${projectName}</strong> has been 
       <strong>automatically cancelled</strong> because the 20-day invoice submission window has elapsed 
       without a valid purchase proof being uploaded. Your allocated slot has been released back to the 
       project pool.`
    )}
    ${infoBox([
      { label: 'Project', value: projectName },
      { label: 'Status',  value: '❌ Reservation Cancelled' },
      { label: 'Reason',  value: 'Invoice not submitted within the 20-day deadline' }
    ])}
    ${productList}
    ${bodyText(
      `While we understand this may be disappointing, the deadline policy ensures fair access for all 
       participants. If you experienced a technical issue that prevented your submission, please reach 
       out to our support team and we will review your case personally.`
    )}
    ${ctaButton('Explore Open Projects', reapplyUrl)}
    ${divider()}
    ${bodyText(
      `We hope to see you participate in future projects. There are always new opportunities available 
       on the platform — keep an eye on your dashboard for upcoming campaigns.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 9b. ADMIN — Budget Restored Notification
// ─────────────────────────────────────────────
/**
 * @param {string} adminName      - Admin's name
 * @param {string} projectName    - Project / brand name
 * @param {string} projectId      - Project ID
 * @param {Array}  expiredSlots   - [{ participantName, participantEmail, products: [{ name, product_value }] }]
 * @param {number} restoredAmount - Total INR restored to the project budget
 * @param {string} dashboardUrl   - Admin approvals page link
 */
const adminBudgetRestoredEmail = ({
  adminName,
  projectName,
  projectId,
  expiredSlots = [],
  restoredAmount = 0,
  dashboardUrl = 'https://nitro.com/admin/product-applications'
}) => {
  const fmt = (n) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n || 0));

  const slotRows = expiredSlots.map((slot) => {
    const productLines = (slot.products || []).map((p) => `
      <div style="padding:6px 0;border-bottom:1px solid #edf0f7;">
        <span style="font-size:13px;color:#1a1a2e;font-weight:600;">${p.name}</span>
        ${p.product_value
          ? `<span style="font-size:12px;color:#9aa3b2;margin-left:8px;">₹${Number(p.product_value).toLocaleString('en-IN')}</span>`
          : ''}
      </div>`).join('');

    return `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1px solid #edf0f7;border-radius:10px;overflow:hidden;
                    margin-bottom:14px;background:#f8f9fc;">
        <tr>
          <td style="padding:14px 16px;">
            <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#1a1a2e;">
              ${slot.participantName || 'Participant'}
            </p>
            <p style="margin:0 0 10px;font-size:12px;color:#9aa3b2;">${slot.participantEmail || ''}</p>
            ${productLines}
            <div style="margin-top:10px;">
              <span style="display:inline-block;padding:3px 12px;border-radius:20px;
                           font-size:11px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#fdecea;color:#c0392b;">
                ✕ Slot Released
              </span>
              ${slot.slotAmount
                ? `<span style="display:inline-block;margin-left:8px;padding:3px 12px;border-radius:20px;
                               font-size:11px;font-weight:700;background:#eafaf1;color:#27ae60;">
                     +${fmt(slot.slotAmount)} restored
                   </span>`
                : ''}
            </div>
          </td>
        </tr>
      </table>`;
  }).join('');

  return wrap(`
    ${heading('Budget Restored — New Slots Available 💰')}
    ${subheading(`Project: ${projectName}`)}
    ${divider()}
    ${greeting(adminName)}
    ${bodyText(
      `This is an automated notification to inform you that <strong>${expiredSlots.length} participant reservation${expiredSlots.length > 1 ? 's' : ''}</strong> 
       for the <strong>${projectName}</strong> project have expired due to non-submission of purchase invoices within the 20-day deadline.`
    )}
    ${bodyText(
      `As a result, the associated product budget has been <strong>automatically released back</strong> to the project pool. 
       You may now review pending applications and approve new participants to fill these vacated slots.`
    )}
    ${infoBox([
      { label: 'Project',          value: projectName },
      { label: 'Expired Slots',    value: `${expiredSlots.length} reservation${expiredSlots.length > 1 ? 's' : ''}` },
      { label: 'Budget Restored',  value: `✅ ${fmt(restoredAmount)} released` }
    ])}
    <p style="margin:28px 0 12px;font-size:15px;font-weight:700;color:#1a1a2e;">
      Released Participant Slots:
    </p>
    ${slotRows}
    ${bodyText(
      `The freed-up budget is now available for new allocations. Head to the approvals dashboard to review 
       any pending product applications and assign these slots to eligible participants.`
    )}
    ${ctaButton('Review Pending Applications', dashboardUrl)}
    ${divider()}
    ${bodyText(
      `This message was generated automatically by the Nitro allocation system. No action is required unless 
       you wish to reassign the released budget to new participants.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">
      Nitro Allocation System<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 10. PAYOUT PAID — Reimbursement transferred
// ─────────────────────────────────────────────
/**
 * @param {string} name            - Participant's full name
 * @param {Array}  items           - [{ projectName, productName, amount }]
 * @param {number} totalAmount     - Total INR paid
 * @param {string} dashboardUrl    - Link to participant payout page
 */
const payoutPaidEmail = (
  name,
  items = [],
  totalAmount = 0,
  dashboardUrl = 'https://nitro.com/dashboard'
) => {
  const fmt = (n) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n || 0));

  const itemRows = items
    .map(
      ({ projectName, productName, amount }) => `
        <tr>
          <td style="padding:10px 16px;font-size:14px;color:#4a5568;border-bottom:1px solid #edf0f7;">
            <strong style="color:#1a1a2e;">${projectName || 'Campaign'}</strong>
            ${productName ? `<br/><span style="font-size:12px;color:#9aa3b2;">${productName}</span>` : ''}
          </td>
          <td style="padding:10px 16px;font-size:14px;font-weight:700;color:#1a7a4a;
                     text-align:right;border-bottom:1px solid #edf0f7;white-space:nowrap;">
            ${fmt(amount)}
          </td>
        </tr>`
    )
    .join('');

  const itemsTable = items.length
    ? `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="background:#f8f9fc;border-radius:8px;border:1px solid #edf0f7;
                    margin:20px 0;overflow:hidden;">
        <thead>
          <tr>
            <th style="padding:10px 16px;font-size:12px;color:#9aa3b2;font-weight:600;
                       text-transform:uppercase;letter-spacing:0.5px;text-align:left;
                       background:#f0f2f5;border-bottom:1px solid #edf0f7;">
              Campaign / Product
            </th>
            <th style="padding:10px 16px;font-size:12px;color:#9aa3b2;font-weight:600;
                       text-transform:uppercase;letter-spacing:0.5px;text-align:right;
                       background:#f0f2f5;border-bottom:1px solid #edf0f7;">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
          <tr>
            <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#1a1a2e;">
              Total Reimbursement
            </td>
            <td style="padding:12px 16px;font-size:16px;font-weight:800;color:#1a7a4a;text-align:right;">
              ${fmt(totalAmount)}
            </td>
          </tr>
        </tbody>
      </table>`
    : infoBox([{ label: 'Total Reimbursement', value: fmt(totalAmount) }]);

  return wrap(`
    ${heading('Your Reimbursement Has Been Transferred! 💸')}
    ${subheading('Great news — your payout is on its way')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `We're pleased to inform you that your reimbursement has been <strong>approved and processed</strong> by our team. 
       The amount will be credited to your registered payment account within the next few business days, 
       depending on your bank's processing time.`
    )}
    ${itemsTable}
    ${bodyText(
      `You can log in to your Nitro dashboard to view the full details of this payout, including 
       the campaign breakdown and current transfer status.`
    )}
    ${ctaButton('View Payout Details', dashboardUrl)}
    ${divider()}
    ${bodyText(
      `If you do not receive the amount within <strong>5 business days</strong>, or if you have any 
       questions about this payment, please don't hesitate to contact our support team — we're 
       happy to help.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">
      Thank you for being a valued part of the Nitro community!<br/><br/>
      Warm regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 11. PRODUCT APPLICATION DECISION — Grouped approved + rejected
// ─────────────────────────────────────────────
/**
 * @param {string} name          - Participant's full name
 * @param {string} projectTitle  - Project/brand name
 * @param {Array}  approved      - [{ name, image_url, product_url, product_value }]
 * @param {Array}  rejected      - [{ name, image_url }]
 * @param {string} dashboardUrl  - CTA link
 */
const productDecisionEmail = (
  name,
  projectTitle = 'Project',
  approved = [],
  rejected = [],
  dashboardUrl = 'https://nitro.com/dashboard'
) => {
  const hasApproved = approved.length > 0;
  const hasRejected = rejected.length > 0;

  // ── Approved product cards ──────────────────────────────────────────────
  const approvedCards = approved
    .map((p) => `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1.5px solid #d4edda;border-radius:12px;overflow:hidden;
                    margin-bottom:14px;background:#f6fff8;">
        <tr>
          ${p.image_url
            ? `<td width="110" style="padding:16px 12px 16px 16px;vertical-align:middle;">
                 <img src="${p.image_url}" width="80" height="80" alt="${p.name}"
                      style="border-radius:8px;object-fit:cover;display:block;
                             border:1px solid #c3e6cb;" />
               </td>`
            : ''}
          <td style="padding:16px;vertical-align:middle;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                           background:#27ae60;flex-shrink:0;"></span>
              <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a2e;">${p.name}</p>
            </div>
            ${p.product_value
              ? `<p style="margin:0 0 10px 16px;font-size:13px;color:#6c8f72;">
                   Value: <strong>₹${Number(p.product_value).toLocaleString('en-IN')}</strong>
                 </p>`
              : ''}
            <div style="margin-left:16px;">
              <span style="display:inline-block;padding:4px 12px;border-radius:20px;
                           font-size:11px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#d4edda;color:#27ae60;
                           margin-bottom:${p.product_url ? '10px' : '0'};">
                ✓ Approved
              </span>
              ${p.product_url
                ? `<br/>
                   <a href="${p.product_url}" target="_blank"
                      style="display:inline-block;margin-top:8px;padding:8px 20px;
                             font-size:13px;font-weight:700;color:#ffffff;
                             background:linear-gradient(135deg,#27ae60,#1e8449);
                             border-radius:6px;text-decoration:none;letter-spacing:0.3px;">
                     🛒 Purchase Now →
                   </a>`
                : ''}
            </div>
          </td>
        </tr>
      </table>`)
    .join('');

  // ── Rejected product cards ──────────────────────────────────────────────
  const rejectedCards = rejected
    .map((p) => `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1.5px solid #f5c6cb;border-radius:12px;overflow:hidden;
                    margin-bottom:14px;background:#fff5f6;">
        <tr>
          ${p.image_url
            ? `<td width="110" style="padding:16px 12px 16px 16px;vertical-align:middle;opacity:0.7;">
                 <img src="${p.image_url}" width="80" height="80" alt="${p.name}"
                      style="border-radius:8px;object-fit:cover;display:block;
                             border:1px solid #f5c6cb;filter:grayscale(30%);" />
               </td>`
            : ''}
          <td style="padding:16px;vertical-align:middle;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                           background:#e74c3c;flex-shrink:0;"></span>
              <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a2e;">${p.name}</p>
            </div>
            <div style="margin-left:16px;">
              <span style="display:inline-block;padding:4px 12px;border-radius:20px;
                           font-size:11px;font-weight:700;letter-spacing:0.5px;
                           text-transform:uppercase;background:#f8d7da;color:#c0392b;">
                ✕ Not Selected
              </span>
            </div>
          </td>
        </tr>
      </table>`)
    .join('');

  // ── Section builder ─────────────────────────────────────────────────────
  const approvedSection = hasApproved ? `
    <div style="margin:28px 0 0;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <div style="width:4px;height:20px;background:#27ae60;border-radius:2px;flex-shrink:0;"></div>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a2e;">
          Approved Product${approved.length > 1 ? 's' : ''}
          <span style="font-size:13px;font-weight:400;color:#27ae60;margin-left:6px;">
            (${approved.length} item${approved.length > 1 ? 's' : ''})
          </span>
        </p>
      </div>
      ${approvedCards}
      <div style="background:#eafaf1;border-left:3px solid #27ae60;border-radius:0 6px 6px 0;
                  padding:12px 16px;margin-top:8px;">
        <p style="margin:0;font-size:14px;color:#1e8449;line-height:1.6;">
          <strong>Next step:</strong> Purchase the approved product${approved.length > 1 ? 's' : ''} and upload your invoice on the Nitro dashboard to proceed.
        </p>
      </div>
    </div>` : '';

  const rejectedSection = hasRejected ? `
    <div style="margin:28px 0 0;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <div style="width:4px;height:20px;background:#e74c3c;border-radius:2px;flex-shrink:0;"></div>
        <p style="margin:0;font-size:15px;font-weight:700;color:#1a1a2e;">
          Not Selected
          <span style="font-size:13px;font-weight:400;color:#e74c3c;margin-left:6px;">
            (${rejected.length} item${rejected.length > 1 ? 's' : ''})
          </span>
        </p>
      </div>
      ${rejectedCards}
      <div style="background:#fdf3f4;border-left:3px solid #e74c3c;border-radius:0 6px 6px 0;
                  padding:12px 16px;margin-top:8px;">
        <p style="margin:0;font-size:14px;color:#922b21;line-height:1.6;">
          These products were not selected this time. You're welcome to explore other available projects on the platform.
        </p>
      </div>
    </div>` : '';

  // ── Summary header config ────────────────────────────────────────────────
  const headingText = hasApproved && hasRejected
    ? 'Your Product Request Update 📋'
    : hasApproved
    ? `Congratulations — You're Approved! 🎉`
    : 'Product Request Update';

  const subText = hasApproved && hasRejected
    ? `Mixed results for your application to <strong>${projectTitle}</strong>`
    : hasApproved
    ? `Your product request for <strong>${projectTitle}</strong> has been approved`
    : `Regarding your product request for <strong>${projectTitle}</strong>`;

  const summaryLine = hasApproved && hasRejected
    ? `We've reviewed all your product requests for the <strong>${projectTitle}</strong> project. Here's a detailed breakdown of each decision:`
    : hasApproved
    ? `Fantastic news! Your product request${approved.length > 1 ? 's' : ''} for <strong>${projectTitle}</strong> ha${approved.length > 1 ? 've' : 's'} been carefully reviewed and <strong>officially approved</strong>. You're all set to move forward — please proceed with the purchase at your earliest convenience.`
    : `Thank you for your interest in the <strong>${projectTitle}</strong> project. After a thorough review, we were unable to approve your product request${rejected.length > 1 ? 's' : ''} at this time. We encourage you to keep an eye out for future opportunities.`;

  return wrap(`
    ${heading(headingText)}
    <p style="margin:0 0 24px;font-size:15px;color:#9aa3b2;font-weight:400;">${subText}</p>
    ${divider()}
    ${greeting(name)}
    ${bodyText(summaryLine)}
    ${approvedSection}
    ${rejectedSection}
    ${divider()}
    ${ctaButton('View My Dashboard', dashboardUrl)}
    ${bodyText(
      `If you have any questions about these decisions or need assistance with the next steps, our support team is always here to help.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Warm regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};


// ─────────────────────────────────────────────
// 12. ALLOCATION CANCELLED — Participant confirmation
// ─────────────────────────────────────────────
/**
 * @param {string} name         - Participant name
 * @param {string} projectName  - Project / brand name
 * @param {Array}  products     - [{ name, image_url, product_value }]
 * @param {string} browseUrl    - Link to explore other projects
 */
const allocationCancelledParticipantEmail = ({
  name,
  projectName,
  products = [],
  browseUrl = 'https://nitro.com/projects'
}) => {
  const productList = products.length ? `
    <p style="margin:24px 0 12px;font-size:15px;font-weight:700;color:#1a1a2e;">
      Cancelled Product${products.length > 1 ? 's' : ''}:
    </p>
    ${products.map((p) => `
      <table cellpadding="0" cellspacing="0" border="0" width="100%"
             style="border:1.5px solid #edf0f7;border-radius:10px;overflow:hidden;
                    margin-bottom:12px;background:#f8f9fc;">
        <tr>
          ${p.image_url
            ? `<td width="90" style="padding:14px 10px 14px 14px;vertical-align:middle;">
                 <img src="${p.image_url}" width="62" height="62" alt="${p.name}"
                      style="border-radius:6px;object-fit:cover;display:block;
                             filter:grayscale(30%);border:1px solid #edf0f7;" />
               </td>`
            : ''}
          <td style="padding:14px 16px;vertical-align:middle;">
            <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#1a1a2e;">${p.name}</p>
            ${p.product_value
              ? `<p style="margin:0 0 8px;font-size:12px;color:#9aa3b2;">
                   Value: ₹${Number(p.product_value).toLocaleString('en-IN')}
                 </p>`
              : ''}
            <span style="display:inline-block;padding:3px 12px;border-radius:20px;
                         font-size:11px;font-weight:700;letter-spacing:0.5px;
                         text-transform:uppercase;background:#fdecea;color:#c0392b;">
              ✕ Reservation Cancelled
            </span>
          </td>
        </tr>
      </table>`).join('')}` : '';

  return wrap(`
    ${heading('Reservation Cancelled')}
    ${subheading(`Your slot for <strong>${projectName}</strong> has been released`)}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `We have successfully processed your cancellation request for <strong>${projectName}</strong>. 
       Your reserved product slot has been released and your allocated budget has been returned to the project pool.`
    )}
    ${infoBox([
      { label: 'Project',  value: projectName },
      { label: 'Status',   value: '✕ Cancelled by participant' },
      { label: 'Budget',   value: '✅ Returned to project pool' }
    ])}
    ${productList}
    ${bodyText(
      `There are always fresh opportunities on the platform. Head over to the projects page to 
       browse available campaigns and apply for ones that suit you.`
    )}
    ${ctaButton('Browse Open Projects', browseUrl)}
    ${divider()}
    ${bodyText(
      `If you cancelled by mistake or have any concerns, please reach out to our support team 
       as soon as possible and we will do our best to assist you.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// 13. ADMIN — Participant Cancelled Allocation
// ─────────────────────────────────────────────
/**
 * @param {string} adminName           - Admin name
 * @param {string} participantName     - Participant who cancelled
 * @param {string} participantEmail    - Participant email
 * @param {string} projectName         - Project name
 * @param {string} projectId           - Project ID
 * @param {Array}  products            - [{ name, image_url, product_value }]
 * @param {number} restoredAmount      - Total INR restored to budget
 * @param {string} dashboardUrl        - Admin approvals page
 */
const adminAllocationCancelledEmail = ({
  adminName,
  participantName,
  participantEmail,
  projectName,
  projectId,
  products = [],
  restoredAmount = 0,
  dashboardUrl = 'https://nitro.com/admin/product-applications'
}) => {
  const fmt = (n) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n || 0));

  const productRows = products.map((p) => `
    <div style="padding:8px 0;border-bottom:1px solid #edf0f7;">
      <span style="font-size:13px;color:#1a1a2e;font-weight:600;">${p.name}</span>
      ${p.product_value
        ? `<span style="font-size:12px;color:#9aa3b2;margin-left:8px;">
             ₹${Number(p.product_value).toLocaleString('en-IN')}
           </span>`
        : ''}
    </div>`).join('');

  return wrap(`
    ${heading('Allocation Cancelled by Participant 🔔')}
    ${subheading(`Project: ${projectName}`)}
    ${divider()}
    ${greeting(adminName)}
    ${bodyText(
      `A participant has voluntarily cancelled their product reservation for <strong>${projectName}</strong>. 
       Their allocated slot has been released and the associated budget has been automatically 
       restored to the project pool.`
    )}
    ${infoBox([
      { label: 'Participant',      value: `${participantName} (${participantEmail})` },
      { label: 'Project',          value: projectName },
      { label: 'Budget Restored',  value: `✅ ${fmt(restoredAmount)} returned to pool` }
    ])}
    ${products.length ? `
    <div style="border:1px solid #edf0f7;border-radius:10px;padding:16px 20px;
                margin:20px 0;background:#f8f9fc;">
      <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#1a1a2e;">
        Released Product${products.length > 1 ? 's' : ''}:
      </p>
      ${productRows}
    </div>` : ''}
    ${bodyText(
      `The freed-up budget is now available for new allocations. You may review pending 
       product applications and assign this slot to another eligible participant.`
    )}
    ${ctaButton('Review Pending Applications', dashboardUrl)}
    ${divider()}
    ${bodyText(
      `This notification was generated automatically by the Nitro platform. No further action is 
       required unless you wish to reassign the released slot.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">
      Nitro Allocation System<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);
};

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────
module.exports = {
  approvalEmail,
  rejectionEmail,
  allocationEmail,
  purchaseApprovedEmail,
  purchaseRejectedEmail,
  reviewApprovedEmail,
  reviewRejectedEmail,
  allocationReminderEmail,
  allocationExpiredEmail,
  payoutPaidEmail,
  productDecisionEmail,
  adminBudgetRestoredEmail,
  allocationCancelledParticipantEmail,
  adminAllocationCancelledEmail,
};