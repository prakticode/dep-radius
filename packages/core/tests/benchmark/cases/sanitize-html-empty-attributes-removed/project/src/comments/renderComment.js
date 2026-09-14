const sanitizeHtml = require("sanitize-html")

function renderComment(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
    },
  })
}

module.exports = { renderComment }
