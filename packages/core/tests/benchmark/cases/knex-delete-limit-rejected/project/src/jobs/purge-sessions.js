const { db } = require("../db")

async function purgeExpiredSessions() {
  const deleted = await db("sessions")
    .where("expires_at", "<", new Date())
    .limit(1000)
    .del()
  return deleted
}

module.exports = { purgeExpiredSessions }
