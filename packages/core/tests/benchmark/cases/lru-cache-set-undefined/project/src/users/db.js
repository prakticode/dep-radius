const { Pool } = require("pg")

const pool = new Pool()

async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT id, email, name FROM users WHERE email = $1", [email])
  return rows[0]
}

module.exports = { findUserByEmail }
