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
const allocationReminderEmail = ({ name, projectName, hoursLeft, expiryDate, dashboardUrl = 'https://nitro.com/dashboard' }) =>
  wrap(`
    ${heading(`Reminder: ${hoursLeft} Hours Left ⏰`)}
    ${subheading('Your product reservation is about to expire — act now!')}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `This is a friendly reminder that your reserved slot for <strong>${projectName}</strong> 
       will <strong>expire in ${hoursLeft} hours</strong>. To keep your allocation active, 
       please upload your purchase proof before the deadline below.`
    )}
    ${infoBox([
      { label: 'Project', value: projectName },
      { label: 'Expires At', value: new Date(expiryDate).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' }) },
      { label: 'Time Remaining', value: `⚠️ ${hoursLeft} hours` }
    ])}
    ${bodyText(
      `Once the deadline passes, your slot will be automatically released and made available 
       to other participants. Don't miss out — upload your proof right away!`
    )}
    ${ctaButton('Upload Invoice Now', dashboardUrl)}
    ${divider()}
    ${bodyText(
      `If you've already uploaded your proof, you can safely ignore this reminder. 
       For any concerns, please contact our support team immediately.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Urgently yours,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

// ─────────────────────────────────────────────
// 9. ALLOCATION EXPIRED
// ─────────────────────────────────────────────
const allocationExpiredEmail = ({ name, projectName, reapplyUrl = 'https://nitro.com/projects' }) =>
  wrap(`
    ${heading('Reservation Expired')}
    ${subheading(`Your slot for ${projectName} has been released`)}
    ${divider()}
    ${greeting(name)}
    ${bodyText(
      `Unfortunately, the purchase proof deadline for your reservation on <strong>${projectName}</strong> 
       has passed without a submission. As a result, your allocated slot has been <strong>released</strong> 
       back to the participant pool.`
    )}
    ${infoBox([
      { label: 'Project', value: projectName },
      { label: 'Status', value: '❌ Reservation Expired' }
    ])}
    ${bodyText(
      `Not all hope is lost! If you're still interested in participating, you're welcome to 
       re-apply for this project or explore other available opportunities on the platform.`
    )}
    ${ctaButton('Explore Open Projects', reapplyUrl)}
    ${divider()}
    ${bodyText(
      `We hope to see you back soon. If you had trouble uploading your proof due to a technical issue, 
       please reach out to our support team and we'll do our best to assist you.`
    )}
    <p style="margin:20px 0 0;font-size:15px;color:#4a5568;">Regards,<br/>
      <strong style="color:#1a1a2e;">The Nitro Team</strong>
    </p>
  `);

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
  allocationExpiredEmail
};