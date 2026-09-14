export type Post = {
  slug: string
  title: string
}

export async function fetchPosts(category: string): Promise<Post[]> {
  const res = await fetch(`/api/posts?category=${encodeURIComponent(category)}`)
  return res.json()
}
