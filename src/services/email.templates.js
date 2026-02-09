const approvalEmail = (name) => `
  <p>Hi ${name || 'Participant'},</p>
  <p>Your account has been <b>approved</b>.</p>
  <p>You can now apply for projects.</p>
  <p>– Nitro Team</p>
`;

const allocationEmail = (projectName, expiryDate) => `
  <p>Your unit has been reserved for <b>${projectName}</b>.</p>
  <p>Please upload purchase proof before <b>${expiryDate}</b>.</p>
`;

const purchaseApprovedEmail = () => `
  <p>Your purchase proof has been <b>approved</b>.</p>
  <p>You may proceed to the next step.</p>
`;

const purchaseRejectedEmail = () => `
  <p>Your purchase proof has been <b>rejected</b>.</p>
  <p>Please re-upload a valid invoice.</p>
`;

module.exports = {
  approvalEmail,
  allocationEmail,
  purchaseApprovedEmail,
  purchaseRejectedEmail
};
