const qs = require("qs")

function parseFilters(url) {
  const query = qs.parse(url.split("?")[1] ?? "")
  const ids = query.ids ?? []
  return {
    ids: ids.map(Number),
    sort: query.sort ?? "name",
  }
}

module.exports = { parseFilters }
