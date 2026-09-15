import ts from "typescript"

import type { LockReader } from "./types.ts"

// bun.lock is JSONC: packages["<key>"] or packages["<parent>/<key>"] = ["name@version", ...].
export function bunLock(text: string): LockReader | undefined {
  const parsed = ts.parseConfigFileTextToJson("bun.lock", text)
  const config = parsed.config as
    | {
        packages?: Record<string, unknown[]>
        // workspaces["" | "<folder>"] repeats what each manifest declared
        workspaces?: Record<string, Record<string, unknown>>
      }
    | undefined
  const packages = config?.packages
  if (!packages) return undefined
  return {
    source: "lockfile:bun",
    lookup(dir, key) {
      const entry = packages[key]
      const ident = Array.isArray(entry) ? entry[0] : undefined
      if (typeof ident !== "string") return undefined
      const at = ident.lastIndexOf("@")
      if (at <= 0) return undefined
      const version = ident.slice(at + 1)
      if (!/^\d/.test(version)) return undefined
      const specifier = declaredIn(
        config.workspaces?.[dir === "." ? "" : dir],
        key
      )
      return {
        version,
        name: ident.slice(0, at),
        ...(specifier !== undefined ? { specifier } : {}),
      }
    },
  }
}

function declaredIn(
  workspace: Record<string, unknown> | undefined,
  key: string
): string | null | undefined {
  if (!workspace) return undefined
  const fields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]
    .map((f) => workspace[f])
    .filter((d): d is Record<string, string> => !!d && typeof d === "object")
  if (fields.length === 0) return undefined
  const spec = fields.find((d) => key in d)?.[key]
  return typeof spec === "string" ? spec : null
}
