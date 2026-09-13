import { loader } from "fumadocs-core/source"
import { defineDocs } from "fumadocs-mdx/macro"
import { pageSchema } from "fumadocs-core/source/schema"

// Articles: a flat folder, no sidebar, rendered inside the home layout
const blog = defineDocs({
  dir: "content/blog",
  docs: { schema: pageSchema },
})

export const blogSource = loader({
  baseUrl: "/blog",
  source: blog.toFumadocsSource(),
})
