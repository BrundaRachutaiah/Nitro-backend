const markAsRead = async (req, res) => {
  res.json({ success: true, message: 'Notification marked as read' });
};

module.exports = { markAsRead };
