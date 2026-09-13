import { resolve } from "node:path"

import { createCtx } from "./context.ts"
import { scanUsage } from "./usage/scan.ts"
import { collectNotes } from "./notes/collect.ts"
import { diffSurfaces } from "./surface/delta.ts"
import { defaultCacheDir } from "./infra/cache.ts"
import { extractSurface } from "./surface/extract.ts"
import { getPackument } from "./registry/packument.ts"
import { buildInventory } from "./inventory/installed.ts"
import { selectCandidate } from "./registry/candidates.ts"
import { listProjectFiles } from "./inventory/manifests.ts"
import { DEFAULT_MIN_AGE_MS, type Options } from "./options.ts"
import { isAgeExcluded, loadRegistryConfig } from "./registry/npmrc.ts"

// Each stage on its own, as JSON, for looking at one step without the rest of the pipeline.
export async function runDebug(args: string[]): Promise<number> {
  const [cmd, ...rest] = args
  const root = resolve(process.env.RADIUS_ROOT ?? process.cwd())
  const now = process.env.RADIUS_NOW
    ? Date.parse(process.env.RADIUS_NOW)
    : Date.now()
  const opts = {
    root,
    specs: [],
    format: "json",
    offline: process.env.RADIUS_OFFLINE === "1",
    minAgeMs: undefined,
    latest: false,
    notes: true,
    surface: true,
    prod: false,
    concurrency: 8,
    cacheDir: process.env.RADIUS_CACHE_DIR ?? defaultCacheDir(process.env),
    verbose: false,
    now,
    color: false,
  } satisfies Options
  const ctx = createCtx(opts)
  const cfg = loadRegistryConfig(root, process.env)
  const print = (v: unknown) =>
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)

  if (cmd === "inventory") {
    const inv = await buildInventory(root, { prod: false })
    print({ ...inv, manifests: inv.manifests.map((m) => m.path) })
    return 0
  }
  if (cmd === "candidates") {
    const inv = await buildInventory(root, { prod: false })
    const out = []
    for (const d of inv.installed) {
      const p = await getPackument(ctx, cfg, d.name)
      if (!p.ok) {
        out.push({ pkg: d.name, error: p.reason })
        continue
      }
      out.push({
        pkg: d.name,
        installed: d.version,
        ...selectCandidate(p.packument, d.version, {
          now,
          minAgeMs: cfg.minimumReleaseAgeMs ?? DEFAULT_MIN_AGE_MS,
          ageExcluded: (v) => isAgeExcluded(cfg, d.name, v),
          latest: false,
        }),
      })
    }
    print(out)
    return 0
  }
  if (cmd === "usage" && rest[0]) {
    const files = await listProjectFiles(root)
    const inv = await buildInventory(root, { prod: false }, files)
    const u = await scanUsage(ctx, root, files, inv)
    print({
      scannedFiles: u.scannedFiles,
      global: u.global,
      packages: Object.values(u.packages).filter((p) => p.pkg === rest[0]),
    })
    return 0
  }
  if (cmd === "notes" && rest[0] && rest[1] && rest[2]) {
    const p = await getPackument(ctx, cfg, rest[0])
    if (!p.ok) return fail(p.reason)
    const c = selectCandidate(p.packument, rest[1], {
      now,
      minAgeMs: 0,
      ageExcluded: () => true,
      latest: false,
      explicit: rest[2],
    })
    if (c.kind !== "candidate") return fail(JSON.stringify(c))
    print(await collectNotes(ctx, cfg, p.packument, c.candidate))
    return 0
  }
  if (cmd === "surface" && rest[0] && rest[1] && rest[2]) {
    const p = await getPackument(ctx, cfg, rest[0])
    if (!p.ok) return fail(p.reason)
    const a = await extractSurface(ctx, cfg, p.packument, rest[1])
    const b = await extractSurface(ctx, cfg, p.packument, rest[2])
    if (!a.ok || !b.ok)
      return fail(JSON.stringify({ from: a.ok || a, to: b.ok || b }))
    const delta = diffSurfaces(a.surface, b.surface)
    print({
      from: {
        version: a.surface.version,
        symbols: Object.keys(a.surface.symbols).length,
        entries: a.surface.entries,
        flags: a.surface.flags,
      },
      to: {
        version: b.surface.version,
        symbols: Object.keys(b.surface.symbols).length,
        entries: b.surface.entries,
        flags: b.surface.flags,
      },
      counts: Object.fromEntries(
        (Object.entries(delta) as [string, unknown[]][]).map(([k, v]) => [
          k,
          v.length,
        ])
      ),
      delta,
    })
    return 0
  }
  return fail(
    "usage: radius debug inventory | candidates | usage <pkg> | notes <pkg> <from> <to> | surface <pkg> <from> <to>"
  )
}

function fail(msg: string): number {
  process.stderr.write(`radius debug: ${msg}\n`)
  return 3
}
