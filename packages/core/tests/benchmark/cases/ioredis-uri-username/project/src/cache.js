const Redis = require("ioredis")

const redis = new Redis(process.env.REDIS_URL)

async function remember(key, ttlSeconds, load) {
  const cached = await redis.get(key)
  if (cached) return JSON.parse(cached)
  const value = await load()
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds)
  return value
}

module.exports = { remember }
