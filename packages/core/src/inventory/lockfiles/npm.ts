import type { LockReader } from "./types.ts"

// package-lock.json v2/v3 and npm-shrinkwrap.json: packages["<dir>/node_modules/<key>"].
export function npmLock(text: string): LockReader | undefined {
  let json: {
    packages?: Record<
      string,
      {
        version?: string
        name?: string
        link?: boolean
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
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
      // the manifest's own entry lists what it declared: "" for the root, its folder for a workspace
      const importer = packages[manifestDir === "." ? "" : manifestDir]
      const declared = importer
        ? [
            importer.dependencies,
            importer.devDependencies,
            importer.optionalDependencies,
            importer.peerDependencies,
          ].filter((d): d is Record<string, string> => !!d)
        : []
      const specifier =
        declared.length === 0
          ? undefined
          : (declared.find((d) => key in d)?.[key] ?? null)
      let dir = manifestDir === "." ? "" : manifestDir
      for (;;) {
        const k = dir ? `${dir}/node_modules/${key}` : `node_modules/${key}`
        const entry = packages[k]
        if (entry?.version && !entry.link)
          return {
            version: entry.version,
            name: entry.name ?? key,
            ...(specifier !== undefined ? { specifier } : {}),
          }
        if (!dir) return undefined
        const i = dir.lastIndexOf("/")
        dir = i < 0 ? "" : dir.slice(0, i)
      }
    },
  }
}
