const { LRUCache } = require("lru-cache")
const { findUserByEmail } = require("./db")

const users = new LRUCache({ max: 1000, ttl: 60 * 1000 })

async function lookupUser(email) {
  if (users.has(email)) {
    return users.get(email)
  }
  const user = await findUserByEmail(email)
  users.set(email, user)
  return user
}

module.exports = { lookupUser }
