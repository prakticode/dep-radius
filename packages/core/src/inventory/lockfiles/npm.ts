import type { LockReader } from "./types.ts"

// package-lock.json v2/v3 and npm-shrinkwrap.json: packages["<dir>/node_modules/<key>"].
export function npmLock(text: string): LockReader | undefined {
  let json: {
    packages?: Record<
      string,
      { version?: string; name?: string; link?: boolean }
    >
  }
  try {
    json = JSON.parse(text) as typeof json
  } catch {
    return undefined
  }
  const packages = json.packages
  if (!packages) return undefined
  return {
    source: "lockfile:npm",
    lookup(manifestDir, key) {
      let dir = manifestDir === "." ? "" : manifestDir
      for (;;) {
        const k = dir ? `${dir}/node_modules/${key}` : `node_modules/${key}`
        const entry = packages[k]
        if (entry?.version && !entry.link)
          return { version: entry.version, name: entry.name ?? key }
        if (!dir) return undefined
        const i = dir.lastIndexOf("/")
        dir = i < 0 ? "" : dir.slice(0, i)
      }
    },
  }
}
