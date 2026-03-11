const transporter = require('../config/mailer');
const env = require('../config/env');

const sendEmail = async ({ to, subject, html }) => {
  try {
    if (!to || !subject || !html) {
      throw new Error('Missing required email fields: to, subject, and html are required');
    }

    const info = await transporter.sendMail({
      from: `"Nitro" <${env.email.user}>`,
      to,
      subject,
      html
    });

    return {
      success: true,
      messageId: info?.messageId || null,
      accepted: info?.accepted || []
    };
  } catch (err) {
    console.error('Email send failed:', {
      to,
      subject,
      code: err?.code || null,
      command: err?.command || null,
      response: err?.response || null,
      message: err?.message || String(err)
    });

    return {
      success: false,
      error: err
    };
  }
};

module.exports = {
  sendEmail
};
