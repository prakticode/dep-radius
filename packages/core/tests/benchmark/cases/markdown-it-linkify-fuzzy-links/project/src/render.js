const markdownit = require("markdown-it")

// comments and chat messages: bare domains like example.com become links
const md = markdownit({ linkify: true })
md.linkify.set({ fuzzyEmail: false })

function renderComment(text) {
  return md.render(text)
}

module.exports = { renderComment }
