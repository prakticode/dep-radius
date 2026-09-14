import { posix } from "node:path"

export interface RuntimeEntry {
  subpath: string
  file: string
}

// Which build to read when a package ships both. The two versions of a diff must read the same
// one, or every function looks changed: the caller picks with `flavorFor`.
export type Flavor = "import" | "require"

// The conditions Node and bundlers apply, taken in the order the export map lists them.
const ACTIVE: Record<Flavor, Set<string>> = {
  import: new Set(["import", "module", "node", "default"]),
  require: new Set(["require", "node", "default"]),
}
const WILDCARD_CAP = 50
const EXTENSIONS = [".js", ".mjs", ".cjs"]

function norm(p: string): string {
  return posix.normalize(p.replace(/^\.\//, "").replace(/^\//, ""))
}

// The runtime twin of surface/entries.ts, which looks for declarations: same export map, other
// conditions and fallbacks.
export function runtimeForTarget(
  value: unknown,
  has: (p: string) => boolean,
  flavor: Flavor,
  star?: string
): string | undefined {
  if (typeof value === "string") {
    const p = star !== undefined ? value.replace(/\*/g, star) : value
    return resolveFile(norm(p), has)
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = runtimeForTarget(v, has, flavor, star)
      if (r) return r
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  for (const [c, v] of Object.entries(value as Record<string, unknown>)) {
    if (!ACTIVE[flavor].has(c)) continue
    const r = runtimeForTarget(v, has, flavor, star)
    if (r) return r
  }
  return undefined
}

// Node's CommonJS lookup, which bundled `require("./x")` and extensionless `main` both rely on.
export function resolveFile(
  p: string,
  has: (p: string) => boolean
): string | undefined {
  if (/\.[cm]?js$/.test(p) && has(p)) return p
  for (const ext of EXTENSIONS) if (has(`${p}${ext}`)) return `${p}${ext}`
  for (const ext of EXTENSIONS)
    if (has(`${p}/index${ext}`)) return `${p}/index${ext}`
  return undefined
}

function exportMapOf(
  pj: Record<string, unknown>
): Record<string, unknown> | undefined {
  const exp = pj.exports
  if (exp === undefined || exp === null) return undefined
  return typeof exp === "string" ||
    Array.isArray(exp) ||
    !Object.keys(exp).some((k) => k.startsWith("."))
    ? { ".": exp }
    : (exp as Record<string, unknown>)
}

// ESM when both versions publish an ESM build, CommonJS otherwise: a package that adds an ESM
// build in the new version is still compared on the CommonJS code both versions have.
export function flavorFor(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Flavor {
  const esm = (pj: Record<string, unknown>) =>
    typeof pj.module === "string" ||
    /"(import|module)"\s*:/.test(JSON.stringify(pj.exports ?? null))
  return esm(a) && esm(b) ? "import" : "require"
}

export function resolveRuntimeEntries(
  pj: Record<string, unknown>,
  files: string[],
  flavor: Flavor
): { entries: RuntimeEntry[]; wildcardTruncated: boolean } {
  const set = new Set(files)
  const has = (p: string) => set.has(p)
  const entries: RuntimeEntry[] = []
  let wildcardTruncated = false
  const exportMap = exportMapOf(pj)

  if (exportMap) {
    for (const [key, value] of Object.entries(exportMap)) {
      if (key === "./package.json" || value === null) continue
      if (!key.includes("*")) {
        const f = runtimeForTarget(value, has, flavor)
        if (f) entries.push({ subpath: key, file: f })
        continue
      }
      const [pre, post] = key.split("*") as [string, string]
      const pattern = firstString(value, flavor)
      if (!pattern?.includes("*")) continue
      const [fpre, fpost] = norm(pattern).split("*") as [string, string]
      const stars = new Set<string>()
      for (const f of files) {
        if (!f.startsWith(fpre)) continue
        const rest = f.slice(fpre.length)
        const star = fpost
          ? rest.endsWith(fpost)
            ? rest.slice(0, -fpost.length)
            : undefined
          : rest.replace(/\.[cm]?js$/, "")
        if (star && !star.includes("/")) stars.add(star)
      }
      const sorted = [...stars].sort()
      if (sorted.length > WILDCARD_CAP) wildcardTruncated = true
      for (const star of sorted.slice(0, WILDCARD_CAP)) {
        const f = runtimeForTarget(value, has, flavor, star)
        if (f) entries.push({ subpath: `${pre}${star}${post}`, file: f })
      }
    }
  } else {
    const order =
      flavor === "import"
        ? [pj.module, pj.main, "index.js"]
        : [pj.main, "index.js", pj.module]
    for (const c of order) {
      if (typeof c !== "string") continue
      const f = resolveFile(norm(c), has)
      if (f) {
        entries.push({ subpath: ".", file: f })
        break
      }
    }
  }
  entries.sort((a, b) =>
    a.subpath === "."
      ? -1
      : b.subpath === "."
        ? 1
        : a.subpath.localeCompare(b.subpath)
  )
  return { entries, wildcardTruncated }
}

function firstString(v: unknown, flavor: Flavor): string | undefined {
  if (typeof v === "string") return v
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = firstString(x, flavor)
      if (r) return r
    }
    return undefined
  }
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!ACTIVE[flavor].has(k)) continue
      const r = firstString(x, flavor)
      if (r) return r
    }
  return undefined
}
