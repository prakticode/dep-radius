const { parse } = require("csv-parse/sync")

function readCustomers(text) {
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  })
  return rows.map((row) => ({ name: row.name, email: row.email }))
}

module.exports = { readCustomers }
