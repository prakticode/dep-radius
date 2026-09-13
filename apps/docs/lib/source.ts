import { defineDocs } from "fumadocs-mdx/macro"
import { llms, loader } from "fumadocs-core/source"
import { metaSchema, pageSchema } from "fumadocs-core/source/schema"
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons"

import { getMDXComponents } from "@/components/mdx"

import { docsContentRoute, docsImageRoute, docsRoute } from "./shared"

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      // a component per page, so the MDX components render their own Markdown form
      includeProcessedMarkdown: { output: "function" },
    },
  },
  meta: {
    schema: metaSchema,
  },
})

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
})

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText("processed", { components: getMDXComponents() })}`,
})
