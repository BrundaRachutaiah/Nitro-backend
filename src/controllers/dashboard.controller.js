const getSummary = async (req, res) => {
  res.json({ success: true, data: {} });
};

const getActivity = async (req, res) => {
  res.json({ success: true, data: [] });
};

const getProjectPerformance = async (req, res) => {
  res.json({ success: true, data: [] });
};

const exportData = async (req, res) => {
  res.json({ success: true, message: 'Export started' });
};

module.exports = {
  getSummary,
  getActivity,
  getProjectPerformance,
  exportData
};
