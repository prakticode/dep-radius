export interface RepoRef {
  host: "github" | "other"
  owner: string
  repo: string
  directory?: string
  raw: string
}

// Every shape `repository` takes in the wild:
// "git+https://github.com/o/r.git", "git+ssh://git@github.com/o/r.git", "github:o/r", "o/r",
// "https://github.com/o/r/tree/main/packages/x", { type, url, directory }
export function parseRepository(input: unknown): RepoRef | undefined {
  let url: string | undefined
  let directory: string | undefined
  if (typeof input === "string") url = input
  else if (input && typeof input === "object") {
    const o = input as { url?: unknown; directory?: unknown }
    if (typeof o.url === "string") url = o.url
    if (typeof o.directory === "string") directory = o.directory
  }
  if (!url) return undefined
  const raw = url.trim()

  const shorthand =
    /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(raw)
  if (
    shorthand?.[1] &&
    shorthand[2] &&
    !raw.includes("://") &&
    !raw.includes("@")
  ) {
    return {
      host: "github",
      owner: shorthand[1],
      repo: shorthand[2],
      ...(directory ? { directory } : {}),
      raw,
    }
  }
  if (/^(gitlab|bitbucket):/.test(raw))
    return { host: "other", owner: "", repo: "", raw }

  const m =
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^/]+\/(.+?))?\/?(?:#.*)?$/.exec(
      raw
    )
  if (m?.[1] && m[2]) {
    const dir = directory ?? m[3]
    return {
      host: "github",
      owner: m[1],
      repo: m[2],
      ...(dir ? { directory: dir.replace(/\/+$/, "") } : {}),
      raw,
    }
  }
  return { host: "other", owner: "", repo: "", raw }
}
