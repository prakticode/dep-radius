import type { LockReader } from "./types.ts"

// yarn.lock v1 ("left-pad@^1.3.0", left-pad@^1.0.0:\n  version "1.3.0") and berry ("left-pad@npm:^1.3.0":\n  version: 1.3.0).
export function yarnLock(text: string): LockReader | undefined {
  const byDescriptor = new Map<string, string>()
  let current: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue
    if (!line.startsWith(" ") && line.endsWith(":")) {
      current = line
        .slice(0, -1)
        .split(/,\s*/)
        .map((d) => d.trim().replace(/^"|"$/g, ""))
      continue
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line)
    if (m?.[1] && current.length > 0) {
      for (const d of current) byDescriptor.set(d, m[1])
      current = []
    }
  }
  if (byDescriptor.size === 0) return undefined
  return {
    source: "lockfile:yarn",
    lookup(_dir, key, spec) {
      const candidates = [`${key}@${spec}`, `${key}@npm:${spec}`]
      if (spec.startsWith("npm:")) candidates.push(`${key}@${spec}`)
      for (const c of candidates) {
        const v = byDescriptor.get(c)
        if (v)
          return {
            version: v,
            name: spec.startsWith("npm:") ? (aliasName(spec) ?? key) : key,
          }
      }
      return undefined
    },
  }
}

function aliasName(spec: string): string | undefined {
  const rest = spec.slice(4)
  const at = rest.lastIndexOf("@")
  return at > 0 ? rest.slice(0, at) : undefined
}
