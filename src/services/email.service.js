const transporter = require('../config/mailer');

const sendEmail = async ({ to, subject, html }) => {
  try {
    await transporter.sendMail({
      from: `"Nitro" <no-reply@nitro.com>`,
      to,
      subject,
      html
    });
  } catch (err) {
    console.error('Email send failed:', err);
  }
};

module.exports = {
  sendEmail
};
