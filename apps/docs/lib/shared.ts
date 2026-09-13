import { createGetUrl } from "fumadocs-core/source"

export const appName = "dep-radius"
export const tagline = "Know which dependency updates touch your code"
export const docsRoute = "/docs"
export const docsImageRoute = "/og/docs"
export const docsContentRoute = "/llms.mdx/docs"

export const gitConfig = {
  user: "prakticode",
  repo: "dep-radius",
  branch: "main",
  // where the pages live inside the repository, for the "edit on GitHub" link
  contentDir: "apps/docs/content/docs",
}

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`
export const npmUrl = "https://www.npmjs.com/package/dep-radius"

const getContentUrl = createGetUrl(docsContentRoute)

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"]

  return { segments, url: getContentUrl(segments, page.locale) }
}

const getImageUrl = createGetUrl(docsImageRoute)

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "image.png"]

  return { segments, url: getImageUrl(segments, page.locale) }
}
