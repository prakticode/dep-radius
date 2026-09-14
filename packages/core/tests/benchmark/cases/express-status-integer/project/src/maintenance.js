const express = require("express")

const app = express()

app.use((req, res, next) => {
  if (process.env.MAINTENANCE !== "on") return next()
  res.status(process.env.MAINTENANCE_STATUS ?? "503").send("Back soon")
})

module.exports = app
