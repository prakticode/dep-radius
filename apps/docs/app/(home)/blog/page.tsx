import Link from "next/link"
import type { Metadata } from "next"

import { blogSource } from "@/lib/blog"

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Real upgrades run through radius: what it found, and what it missed.",
}

export default function BlogIndex() {
  const posts = blogSource.getPages()
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">Blog</h1>
      <ul className="flex flex-col gap-6">
        {posts.map((post) => (
          <li key={post.url}>
            <Link href={post.url} className="group flex flex-col gap-1">
              <span className="text-lg font-medium group-hover:text-fd-primary">
                {post.data.title}
              </span>
              <span className="text-fd-muted-foreground">
                {post.data.description}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
