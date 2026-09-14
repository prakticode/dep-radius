const { marked } = require("marked")

marked.use({
  gfm: true,
  headerIds: true,
  headerPrefix: "section-",
  mangle: false,
})

function renderPage(markdown) {
  return marked.parse(markdown)
}

module.exports = { renderPage }
