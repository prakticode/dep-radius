import { marked } from "marked"

marked.use({
  renderer: {
    codespan({ text }) {
      return `<code class="inline-code">${text}</code>`
    },
  },
})

export function renderComment(body: string) {
  return marked.parse(body, { async: false })
}
