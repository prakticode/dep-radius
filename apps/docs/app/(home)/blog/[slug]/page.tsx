import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { blogSource } from "@/lib/blog"
import { getMDXComponents } from "@/components/mdx"

export default async function Post(props: PageProps<"/blog/[slug]">) {
  const { slug } = await props.params
  const post = blogSource.getPage([slug])
  if (!post) notFound()
  const MDX = post.data.body

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="mb-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {post.data.title}
      </h1>
      <p className="mb-10 text-lg text-fd-muted-foreground">
        {post.data.description}
      </p>
      <article className="prose min-w-0">
        <MDX components={getMDXComponents()} />
      </article>
    </main>
  )
}

export function generateStaticParams() {
  return blogSource.getPages().map((post) => ({ slug: post.slugs[0]! }))
}

export async function generateMetadata(
  props: PageProps<"/blog/[slug]">
): Promise<Metadata> {
  const { slug } = await props.params
  const post = blogSource.getPage([slug])
  if (!post) notFound()
  return {
    title: post.data.title,
    description: post.data.description,
    openGraph: { type: "article" },
  }
}
