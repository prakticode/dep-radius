const fs = require("node:fs/promises")
const sass = require("sass")

async function buildStyles() {
  const result = await sass.compileAsync("src/styles/main.scss")
  await fs.mkdir("dist", { recursive: true })
  await fs.writeFile("dist/main.css", result.css)
}

module.exports = { buildStyles }
