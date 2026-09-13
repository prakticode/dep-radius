import { ALGO } from "./signature.ts"
import type { Ctx } from "../options.ts"
import { declaresTypes } from "./entries.ts"
import { extractSurface } from "./extract.ts"
import { uniqueSites } from "../analyze/brief.ts"
import { getTarballFiles } from "../registry/tarball.ts"
import type { Packument } from "../registry/packument.ts"
import type { RegistryConfig } from "../registry/npmrc.ts"
import { diffSurfaces, surfaceChangeCount } from "./delta.ts"
import { lastName, parsePath, resolveRef } from "../symbol-path.ts"
import type {
  BlindSpotKind,
  Candidate,
  Counted,
  PackageBrief,
  PackageUsage,
  Site,
  SurfaceChange,
  SurfaceDelta,
  Touched,
} from "../model.ts"

export type SurfaceOutcome = PackageBrief["surface"] & {
  truncatedOnUsedEntry?: boolean
  blindSpots?: Counted<BlindSpotKind>[]
}

export interface SurfaceContext {
  // @types/<name> is installed next to the package
  typesPackageInstalled: boolean
}

export async function analyzeSurface(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  c: Candidate,
  usage: PackageUsage | undefined,
  sctx: SurfaceContext = { typesPackageInstalled: false }
): Promise<SurfaceOutcome> {
  const refs = usage?.refs ?? []
  // no named usage: a diff would have nothing to land on, and costs two downloads
  if (refs.length === 0)
    return {
      status: "disabled",
      detail: "not computed: no named usage to compare",
      touched: [],
    }

  const from = p.versions[c.from]
  const to = p.versions[c.to]
  if (!from || !to)
    return {
      status: "failed",
      detail: "installed version missing from the registry",
      touched: [],
    }

  if (declaresTypes(from) === undefined && declaresTypes(to) === undefined) {
    const tb = await getTarballFiles(ctx, cfg, to)
    if (tb.ok && ![...tb.files.keys()].some((f) => /\.d\.[cm]?ts$/.test(f))) {
      return {
        status: sctx.typesPackageInstalled ? "types-from-@types" : "no-types",
        touched: [],
      }
    }
    if (!tb.ok && tb.reason === "offline-uncached")
      return { status: "offline-uncached", touched: [] }
  }

  const wanted = [...new Set(refs.map((r) => r.entry))]
  const [a, b] = await Promise.all([
    extractSurface(ctx, cfg, p, c.from, wanted),
    extractSurface(ctx, cfg, p, c.to, wanted),
  ])
  if (!a.ok || !b.ok) {
    const bad = !a.ok ? a : !b.ok ? b : undefined
    if (bad?.reason === "no-types")
      return {
        status: sctx.typesPackageInstalled ? "types-from-@types" : "no-types",
        touched: [],
      }
    if (bad?.reason === "offline-uncached")
      return { status: "offline-uncached", touched: [] }
    return {
      status: "failed",
      detail: `type surface: ${bad?.detail ?? "extraction failed"}`,
      touched: [],
    }
  }

  const deltaKey = `deltas/${keyOf(a.surface.integrity)}__${keyOf(b.surface.integrity)}.a${ALGO}.json`
  let delta = (await ctx.cache.getJson<SurfaceDelta>(deltaKey))?.value
  if (!delta) {
    delta = diffSurfaces(a.surface, b.surface)
    await ctx.cache.setJson(deltaKey, delta, ctx.now)
  }

  // resolve every reference against the OLD surface: what the code compiles against today
  const byPath = new Map<string, Site[]>()
  const byMember = new Map<string, Site[]>()
  const missing: Site[] = []
  const missingEntries = new Set<string>()
  const add = (m: Map<string, Site[]>, k: string, s: Site) => {
    const l = m.get(k) ?? []
    l.push(s)
    m.set(k, l)
  }
  for (const r of refs) {
    const res = resolveRef(a.surface, r)
    for (const path of res.paths) add(byPath, path, r.site)
    for (const name of res.unresolvedTail) add(byMember, name, r.site)
    if (res.missingHead) {
      missing.push(r.site)
      missingEntries.add(r.origin?.entry ?? r.entry)
    }
  }

  // `export * from "other-lib"`: the names live in another package's types, which radius does not
  // follow. The notes are the only net here, said as such rather than as a hundred blind spots.
  const elsewhere = [
    ...new Set(
      [...missingEntries].flatMap(
        (e) => a.surface.entries[e]?.externalReexports ?? []
      )
    ),
  ]
  if (elsewhere.length > 0) {
    return {
      status: "types-elsewhere",
      detail: `its types are re-exported from ${elsewhere.join(", ")}, which is not followed`,
      touched: [],
    }
  }

  const touched: Touched[] = []
  const consider = (bucket: Touched["bucket"], change: SurfaceChange) => {
    const all = [change.path, ...change.alsoAt]
    const strongSites: Site[] = []
    for (const path of all) {
      strongSites.push(...(byPath.get(path) ?? []))
      if (bucket === "removed") {
        // a removed namespace or type takes every path under it
        for (const [used, sites] of byPath)
          if (used.startsWith(`${path}.`) || used.startsWith(`${path}#`))
            strongSites.push(...sites)
      }
    }
    if (strongSites.length > 0) {
      touched.push({
        change,
        bucket,
        strength: "strong",
        sites: uniqueSites(strongSites),
      })
      return
    }
    // a member you reach through a value the walk lost track of: same name, possibly the same thing
    if (all.some((p) => parsePath(p).segs.at(-1)?.sep === "#")) {
      const sites = byMember.get(lastName(change.path))
      if (sites && sites.length > 0)
        touched.push({
          change,
          bucket,
          strength: "weak",
          sites: uniqueSites(sites),
        })
    }
  }
  for (const ch of delta.removed) consider("removed", ch)
  for (const ch of delta.changed) consider("changed", ch)
  for (const ch of delta.deprecated) consider("deprecated", ch)

  const usedEntries = new Set(wanted)
  const truncatedOnUsedEntry =
    a.surface.flags.includes("symbol-cap") ||
    b.surface.flags.includes("symbol-cap") ||
    [...usedEntries].some(
      (e) =>
        !a.surface.entries[e] &&
        (a.surface.flags.includes("wildcard-truncated") ||
          b.surface.flags.includes("wildcard-truncated"))
    )

  return {
    status: "computed",
    changes: surfaceChangeCount(delta),
    added: delta.added.length,
    touched: touched.sort(
      (x, y) =>
        order(x) - order(y) || x.change.path.localeCompare(y.change.path)
    ),
    truncatedOnUsedEntry,
    ...(missing.length > 0
      ? {
          blindSpots: [
            {
              kind: "unresolved-against-surface" as const,
              count: missing.length,
              examples: uniqueSites(missing).slice(0, 3),
            },
          ],
        }
      : {}),
  }
}

function order(t: Touched): number {
  return (
    (t.bucket === "removed" ? 0 : t.bucket === "changed" ? 2 : 4) +
    (t.strength === "weak" ? 1 : 0)
  )
}

function keyOf(integrity: string): string {
  return Buffer.from(integrity).toString("base64url").slice(0, 48)
}
