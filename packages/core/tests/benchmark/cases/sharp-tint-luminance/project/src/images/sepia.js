const sharp = require("sharp")

async function toSepia(input) {
  return sharp(input)
    .resize(1200)
    .tint({ r: 112, g: 66, b: 20 })
    .jpeg({ quality: 80 })
    .toBuffer()
}

module.exports = { toSepia }
