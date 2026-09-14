const express = require("express")
const bodyParser = require("body-parser")

const app = express()
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES)

app.use(bodyParser.json({ limit: maxBodyBytes }))

app.post("/api/events", (req, res) => {
  res.status(202).json({ received: Array.isArray(req.body) ? req.body.length : 1 })
})

app.listen(process.env.PORT || 3000)
