const verifyAuth = (req, res) => {
  res.json({
    success: true,
    message: 'Authenticated',
    user: req.user
  });
};

module.exports = {
  verifyAuth
};
