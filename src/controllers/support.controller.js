const createTicket = async (req, res) => {
  res.json({ success: true, message: 'Support ticket created' });
};

const getMyTickets = async (req, res) => {
  res.json({ success: true, data: [] });
};

module.exports = {
  createTicket,
  getMyTickets
};
