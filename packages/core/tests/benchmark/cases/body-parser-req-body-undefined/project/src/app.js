const express = require("express")
const bodyParser = require("body-parser")

const app = express()

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

app.post("/api/orders/:id/cancel", (req, res) => {
  const reason = req.body.reason || "customer request"
  res.json({ id: req.params.id, status: "cancelled", reason })
})

module.exports = app
