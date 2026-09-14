const { XMLParser } = require("fast-xml-parser")

const parser = new XMLParser({ ignoreAttributes: false })

function parseCatalog(xml) {
  const { catalog } = parser.parse(xml)
  return catalog.product.map((product) => ({
    sku: String(product.sku),
    name: product.name,
    price: product.price,
  }))
}

module.exports = { parseCatalog }
