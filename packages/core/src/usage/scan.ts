import { sha1 } from "../infra/hash.ts"
import type { Ctx } from "../options.ts"
import { findOpaque } from "./opaque.ts"
import { counted, link } from "./link.ts"
import { LocalResolver } from "./resolve-local.ts"
import { isScannable, readSource, skippedByLocation } from "./files.ts"
import type { Inventory, OpaqueKind, Site, UsageMap } from "../model.ts"
import { type FileFacts, parseSource, SCANNER_VERSION } from "./parse.ts"

export async function scanUsage(
  ctx: Ctx | undefined,
  root: string,
  files: string[],
  inventory: Inventory,
  onFile: (done: number, total: number) => void = () => {}
): Promise<UsageMap> {
  const facts = new Map<string, FileFacts>()
  const skipped: Site[] = []
  const total = files.filter(
    (f) => isScannable(f) && !skippedByLocation(f)
  ).length
  let done = 0
  for (const rel of files) {
    if (skippedByLocation(rel)) {
      skipped.push({
        file: rel,
        line: 1,
        col: 1,
        typeOnly: false,
        text: "generated folder",
      })
      continue
    }
    if (!isScannable(rel)) continue
    if (++done % 25 === 0 || done === total) onFile(done, total)
    let src
    try {
      src = await readSource(root, rel)
    } catch {
      continue
    }
    if ("reason" in src) {
      skipped.push({
        file: rel,
        line: 1,
        col: 1,
        typeOnly: false,
        text: src.reason,
      })
      continue
    }
    const key = `facts/v${SCANNER_VERSION}/${sha1(rel + "\0" + src.blocks.map((b) => b.text).join("\0"))}.json`
    const cached = ctx ? await ctx.cache.getJson<FileFacts>(key) : undefined
    if (cached) {
      facts.set(rel, cached.value)
      continue
    }
    const f = parseSource(src)
    facts.set(rel, f)
    if (ctx) await ctx.cache.setJson(key, f, ctx.now)
  }

  const resolver = new LocalResolver(root, files, inventory)
  const linked = await link({
    root,
    facts,
    resolver,
    inventory,
    globalSkipped: skipped,
  })
  const opaque = await findOpaque(root, files, facts, inventory, resolver)

  const packages = linked.packages
  for (const [id, kinds] of opaque) {
    const dep = inventory.installed.find((d) => d.id === id)
    const existing = packages[id]
    const merged = new Map<OpaqueKind, Site[]>()
    for (const o of existing?.opaque ?? [])
      merged.set(o.kind, [
        ...(linked.acc.get(id)?.opaque.get(o.kind) ?? o.examples),
      ])
    for (const [k, sites] of kinds) {
      // a package named in a config string but also imported by name is visible (a lint rule naming
      // a package is not that package configured by string); one known only by the string is not
      if (k === "config-reference" && (existing?.refs.length ?? 0) > 0) continue
      merged.set(k, [...(merged.get(k) ?? []), ...sites])
    }
    packages[id] = {
      installedId: id,
      pkg: existing?.pkg ?? dep?.name ?? id,
      refs: existing?.refs ?? [],
      strongNames: existing?.strongNames ?? [],
      weakNames: existing?.weakNames ?? [],
      files: existing?.files ?? 0,
      blindSpots: existing?.blindSpots ?? [],
      opaque: counted(merged),
    }
  }
  return { scannedFiles: linked.scannedFiles, packages, global: linked.global }
}
