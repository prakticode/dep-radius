const express = require("express")

const router = express.Router()

router.post("/settings", (req, res) => {
  req.session.settings = req.body
  res.redirect("back")
})

module.exports = router
