const express = require("express")
const multer = require("multer")

const upload = multer({
  dest: "uploads/avatars",
  limits: { fileSize: 0.2 * 1024 * 1024 },
})

const router = express.Router()

router.post("/avatar", upload.single("avatar"), (req, res) => {
  req.user.avatarPath = req.file.path
  res.status(204).end()
})

module.exports = router
