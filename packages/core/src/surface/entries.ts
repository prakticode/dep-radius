import semver from "semver"
import ts from "typescript"

export interface EntryFile {
  subpath: string
  typesFile: string
}

export interface EntryResolution {
  entries: EntryFile[]
  wildcardTruncated: boolean
}

const WILDCARD_CAP = 50
const RUNTIME_CONDITIONS = ["import", "require", "node", "default", "module"]

// A `types` condition anywhere in an export's condition tree wins; otherwise a runtime file with a
// declaration beside it. Custom conditions ("@acme/source") point at sources and are ignored.
export function typesForTarget(
  value: unknown,
  has: (p: string) => boolean,
  star?: string
): string | undefined {
  const sub = (s: string) => (star !== undefined ? s.replace(/\*/g, star) : s)
  if (typeof value === "string") {
    const p = norm(sub(value))
    if (/\.d\.[cm]?ts$/.test(p)) return has(p) ? p : undefined
    for (const d of declarationFor(p)) if (has(d)) return d
    return undefined
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = typesForTarget(v, has, star)
      if (r) return r
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const o = value as Record<string, unknown>
  if ("types" in o) {
    const r = typesForTarget(o.types, has, star)
    if (r) return r
  }
  for (const c of RUNTIME_CONDITIONS) {
    if (!(c in o)) continue
    const r = typesForTarget(o[c], has, star)
    if (r) return r
  }
  return undefined
}

function declarationFor(p: string): string[] {
  const m = /\.(m|c)?js$/.exec(p)
  if (m) {
    const base = p.slice(0, -m[0].length)
    return [`${base}.d.${m[1] ?? ""}ts`, `${base}.d.ts`]
  }
  if (/\.[cm]?ts$/.test(p) && !/\.d\.[cm]?ts$/.test(p))
    return [p.replace(/\.([cm]?)ts$/, ".d.$1ts")]
  return [`${p}.d.ts`, `${p}/index.d.ts`]
}

function norm(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\//, "")
}

export function resolveEntries(
  pj: Record<string, unknown>,
  files: string[],
  wantedSubpaths: string[] = []
): EntryResolution {
  const set = new Set(files)
  const has = (p: string) => set.has(p)
  const entries: EntryFile[] = []
  let wildcardTruncated = false
  const exp = pj.exports

  const exportMap: Record<string, unknown> | undefined =
    exp === undefined
      ? undefined
      : typeof exp === "string" ||
          Array.isArray(exp) ||
          !Object.keys(exp as object).some((k) => k.startsWith("."))
        ? { ".": exp }
        : (exp as Record<string, unknown>)

  if (exportMap) {
    for (const [key, value] of Object.entries(exportMap)) {
      if (key === "./package.json" || value === null) continue
      if (!key.includes("*")) {
        const t = typesForTarget(value, has)
        if (t) entries.push({ subpath: key, typesFile: t })
        continue
      }
      const [pre, post] = key.split("*") as [string, string]
      const pattern = firstString(value)
      if (!pattern || !pattern.includes("*")) continue
      const [fpre, fpost] = norm(pattern).split("*") as [string, string]
      const stars = new Set<string>()
      for (const f of files) {
        if (!f.startsWith(fpre)) continue
        const rest = f.slice(fpre.length)
        const star = fpost
          ? rest.endsWith(fpost)
            ? rest.slice(0, -fpost.length)
            : undefined
          : rest.replace(/\.d\.[cm]?ts$|\.[cm]?js$/, "")
        if (star && !star.includes("/")) stars.add(star)
      }
      const sorted = [...stars].sort()
      const wanted = sorted.filter((s) =>
        wantedSubpaths.includes(`${pre}${s}${post}`)
      )
      const picked = [...new Set([...sorted.slice(0, WILDCARD_CAP), ...wanted])]
      if (sorted.length > picked.length) wildcardTruncated = true
      for (const star of picked) {
        const t = typesForTarget(value, has, star)
        if (t) entries.push({ subpath: `${pre}${star}${post}`, typesFile: t })
      }
    }
  } else {
    let main =
      typeof pj.types === "string"
        ? pj.types
        : typeof pj.typings === "string"
          ? pj.typings
          : undefined
    const tv = pj.typesVersions as
      Record<string, Record<string, string[]>> | undefined
    if (tv) {
      const range = Object.keys(tv).find(
        (r) => r === "*" || semver.satisfies(ts.version, r)
      )
      const mapping = range ? tv[range] : undefined
      const star = mapping?.["*"]?.[0]
      if (star)
        main = star.replace("*", (main ?? "index.d.ts").replace(/^\.\//, ""))
    }
    const candidates = [
      main,
      typeof pj.main === "string" ? pj.main : undefined,
      "index.d.ts",
    ].filter((x): x is string => !!x)
    for (const c of candidates) {
      const t = /\.d\.[cm]?ts$/.test(c)
        ? has(norm(c))
          ? norm(c)
          : undefined
        : declarationFor(norm(c)).find(has)
      if (t) {
        entries.push({ subpath: ".", typesFile: t })
        break
      }
    }
    for (const w of wantedSubpaths) {
      if (w === ".") continue
      const t = declarationFor(norm(w)).find(has)
      if (t) entries.push({ subpath: w, typesFile: t })
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

function firstString(v: unknown): string | undefined {
  if (typeof v === "string") return v
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = firstString(x)
      if (r) return r
    }
    return undefined
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    for (const k of ["types", ...RUNTIME_CONDITIONS])
      if (k in o) {
        const r = firstString(o[k])
        if (r) return r
      }
  }
  return undefined
}

// Whether a version ships its own declarations, read from the packument without a download.
export function declaresTypes(pv: {
  types?: string
  typings?: string
  exports?: unknown
}): boolean | undefined {
  if (pv.types || pv.typings) return true
  if (
    pv.exports !== undefined &&
    JSON.stringify(pv.exports).includes('"types"')
  )
    return true
  if (
    pv.exports !== undefined &&
    /\.d\.[cm]?ts"/.test(JSON.stringify(pv.exports))
  )
    return true
  return undefined
}
