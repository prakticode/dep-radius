const Papa = require("papaparse")

function parsePriceList(csvText) {
  const { data, errors } = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
  })
  if (errors.length > 0) {
    throw new Error(errors[0].message)
  }
  return data.map((row) => ({ sku: row.sku, price: Number(row.price) }))
}

module.exports = { parsePriceList }
