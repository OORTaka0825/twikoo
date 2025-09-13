module.exports = (req, res) => {
  res.status(200).json({ ok: true, node: process.version, path: req.url });
};
