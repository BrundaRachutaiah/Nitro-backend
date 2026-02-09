const getMyActivity = async (req, res) => {
  res.json({ success: true, data: [] });
};

const getAdminActivity = async (req, res) => {
  res.json({ success: true, data: [] });
};

module.exports = {
  getMyActivity,
  getAdminActivity
};
