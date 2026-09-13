import ts from "typescript"

import type { LockReader } from "./types.ts"

// bun.lock is JSONC: packages["<key>"] or packages["<parent>/<key>"] = ["name@version", ...].
export function bunLock(text: string): LockReader | undefined {
  const parsed = ts.parseConfigFileTextToJson("bun.lock", text)
  const packages = (
    parsed.config as { packages?: Record<string, unknown[]> } | undefined
  )?.packages
  if (!packages) return undefined
  return {
    source: "lockfile:bun",
    lookup(_dir, key) {
      const entry = packages[key]
      const ident = Array.isArray(entry) ? entry[0] : undefined
      if (typeof ident !== "string") return undefined
      const at = ident.lastIndexOf("@")
      if (at <= 0) return undefined
      const version = ident.slice(at + 1)
      return /^\d/.test(version)
        ? { version, name: ident.slice(0, at) }
        : undefined
    },
  }
}
