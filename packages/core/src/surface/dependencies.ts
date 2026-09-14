import semver from "semver"
import ts from "typescript"

import type { Ctx } from "../options.ts"
import { getTarballFiles } from "../registry/tarball.ts"
import type { RegistryConfig } from "../registry/npmrc.ts"
import { getPackument, type Packument } from "../registry/packument.ts"

// A package's declarations often use types another package declares: `useQuery(options:
// UseQueryOptions)` where the options come from a dependency. Those types are part of the package's
// API, so the surface loads them: one level down, only the dependencies the declarations import,
// at the version the package's own range picks.

export interface DependencyLimits {
  // dependencies tried, in name order: each costs a packument and a tarball
  packages: number
  // declaration bytes of one dependency; past it, a whole platform rather than a few types
  bytesEach: number
  bytesTotal: number
}

export const DEPENDENCY_LIMITS: DependencyLimits = {
  packages: 8,
  bytesEach: 8 * 1024 * 1024,
  bytesTotal: 16 * 1024 * 1024,
}

// declaration files read for their imports; a package with more is already past what matters here
const SCAN_CAP = 2000

export interface DependencyTypes {
  // name -> package.json and declaration files of the resolved version
  packages: Map<string, Map<string, Buffer>>
  // name -> version, for the ones loaded
  versions: Record<string, string>
  // one could not be loaded for a reason that may pass (offline, the network): a surface built
  // without it is not the package's surface, and is not worth keeping
  transient: boolean
}

const DECLARATION = /\.d\.[cm]?ts$/

// "@scope/name/sub" -> "@scope/name", "name/sub" -> "name"; nothing for relative paths and builtins
export function packageOfSpecifier(spec: string): string | undefined {
  if (/^[./]|^[a-z][\w+.-]*:/i.test(spec)) return undefined
  const parts = spec.split("/")
  if (spec.startsWith("@"))
    return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined
  return parts[0] || undefined
}

function typesPackageOf(name: string): string {
  return name.startsWith("@")
    ? `@types/${name.slice(1).replace("/", "__")}`
    : `@types/${name}`
}

// The dependencies (or peer dependencies) of a version that its declarations import, with the
// range the version asks for, in name order.
export function importedDependencies(
  pkg: string,
  files: Map<string, Buffer>
): { name: string; range: string }[] {
  let pj: Record<string, unknown>
  try {
    pj = JSON.parse(
      files.get("package.json")?.toString("utf8") ?? "{}"
    ) as Record<string, unknown>
  } catch {
    return []
  }
  const ranges: Record<string, string> = {}
  for (const field of ["peerDependencies", "dependencies"]) {
    const deps = pj[field]
    if (!deps || typeof deps !== "object") continue
    for (const [name, range] of Object.entries(deps as Record<string, unknown>))
      if (typeof range === "string") ranges[name] = range
  }
  const imported = new Set<string>()
  let scanned = 0
  for (const [path, buf] of files) {
    if (!DECLARATION.test(path)) continue
    if (++scanned > SCAN_CAP) break
    const info = ts.preProcessFile(buf.toString("utf8"), true, true)
    for (const ref of [
      ...info.importedFiles,
      ...info.typeReferenceDirectives,
    ]) {
      const name = packageOfSpecifier(ref.fileName)
      if (!name) continue
      // `import "serve-static"` in @types/express is answered by its dependency @types/serve-static
      for (const candidate of [name, typesPackageOf(name)])
        if (candidate !== pkg && ranges[candidate] !== undefined)
          imported.add(candidate)
    }
  }
  return [...imported].sort().map((name) => ({ name, range: ranges[name]! }))
}

// The version a range picks today: the highest that satisfies it, or the version a dist-tag names.
export function resolveRange(p: Packument, range: string): string | undefined {
  const tagged = p["dist-tags"][range]
  if (tagged && p.versions[tagged]) return tagged
  if (!semver.validRange(range)) return undefined
  return semver.maxSatisfying(Object.keys(p.versions), range) ?? undefined
}

export async function loadDependencyTypes(
  ctx: Ctx,
  cfg: RegistryConfig,
  pkg: string,
  files: Map<string, Buffer>,
  limits: DependencyLimits = DEPENDENCY_LIMITS
): Promise<DependencyTypes> {
  const wanted = importedDependencies(pkg, files).slice(0, limits.packages)
  let transient = false
  const loaded = await Promise.all(
    wanted.map(async ({ name, range }) => {
      const pack = await getPackument(ctx, cfg, name)
      if (!pack.ok) {
        if (pack.reason === "offline-uncached" || pack.reason === "http-error")
          transient = true
        return undefined
      }
      const version = resolveRange(pack.packument, range)
      const pv = version ? pack.packument.versions[version] : undefined
      if (!version || !pv) return undefined
      const tb = await getTarballFiles(ctx, cfg, pv)
      if (!tb.ok) {
        if (tb.reason !== "integrity-mismatch") transient = true
        return undefined
      }
      const kept = new Map<string, Buffer>()
      let bytes = 0
      for (const [path, buf] of tb.files)
        if (path === "package.json" || DECLARATION.test(path)) {
          kept.set(path, buf)
          if (path !== "package.json") bytes += buf.length
        }
      // `react` without types, or a platform too large to be a few option types
      if (bytes === 0 || bytes > limits.bytesEach) return undefined
      return { name, version, files: kept, bytes }
    })
  )
  const packages = new Map<string, Map<string, Buffer>>()
  const versions: Record<string, string> = {}
  let total = 0
  for (const dep of loaded) {
    if (!dep || total + dep.bytes > limits.bytesTotal) continue
    total += dep.bytes
    packages.set(dep.name, dep.files)
    versions[dep.name] = dep.version
  }
  return { packages, versions, transient }
}
