const accounts = new Map()

async function verify(username, password) {
  const account = accounts.get(username)
  return account && account.password === password ? account : null
}

async function findById(id) {
  return [...accounts.values()].find((account) => account.id === id) ?? null
}

module.exports = { verify, findById }
