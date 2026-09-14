import { createRequire } from "node:module"

import semver from "semver"
import ts from "typescript"

import { scanUsage } from "./usage/scan.ts"
import { matchNotes } from "./notes/match.ts"
import { limitsFor } from "./render/limits.ts"
import { collectNotes } from "./notes/collect.ts"
import { buildPackageBrief } from "./analyze/brief.ts"
import { getPackument } from "./registry/packument.ts"
import { buildInventory } from "./inventory/installed.ts"
import { selectCandidate } from "./registry/candidates.ts"
import { listProjectFiles } from "./inventory/manifests.ts"
import { planSince, readBaseTree } from "./inventory/since.ts"
import { implementationHints } from "./facts/implementation/hints.ts"
import { isAgeExcluded, loadRegistryConfig } from "./registry/npmrc.ts"
import { analyzeSurface, type SurfaceOutcome } from "./surface/analyze.ts"
import {
  type Ctx,
  DEFAULT_MIN_AGE_MS,
  type Options,
  type RunEvent,
} from "./options.ts"
import type {
  Brief,
  InstalledDep,
  NotAnalyzed,
  PackageBrief,
  PackageUsage,
  UsageMap,
} from "./model.ts"

export function toolVersion(): string {
  try {
    return (
      createRequire(import.meta.url)("../package.json") as { version: string }
    ).version
  } catch {
    return "0.0.0"
  }
}

export interface Spec {
  name: string
  version?: string
}

export function parseSpec(input: string): Spec {
  const at = input.lastIndexOf("@")
  if (at > 0) return { name: input.slice(0, at), version: input.slice(at + 1) }
  return { name: input }
}

export async function run(
  opts: Options,
  ctx: Ctx,
  onEvent: (e: RunEvent) => void = () => {}
): Promise<Brief> {
  const root = opts.root
  const files = await listProjectFiles(root)
  const inventory = await buildInventory(root, { prod: opts.prod }, files)
  const cfg = loadRegistryConfig(root, ctx.env)
  const minAgeMs =
    opts.minAgeMs ?? cfg.minimumReleaseAgeMs ?? DEFAULT_MIN_AGE_MS
  const specs = opts.specs.map(parseSpec)
  if (opts.since && (opts.latest || specs.some((s) => s.version)))
    throw new Error(
      "--since compares with a commit, so it takes package names only, without --latest or @version"
    )

  const notAnalyzed: NotAnalyzed[] = [...inventory.notAnalyzed]
  let targets: InstalledDep[] = inventory.installed
  if (specs.length > 0) {
    targets = inventory.installed.filter((d) =>
      specs.some(
        (s) => s.name === d.name || d.declaredBy.some((b) => b.key === s.name)
      )
    )
    for (const s of specs) {
      if (
        !targets.some(
          (d) => d.name === s.name || d.declaredBy.some((b) => b.key === s.name)
        )
      ) {
        notAnalyzed.push({
          pkg: s.name,
          reason: inventory.local.includes(s.name)
            ? "a local workspace package"
            : "not a dependency of this project",
        })
      }
    }
  }
  let since: Brief["since"]
  // with --since, the version a dependency has now is the target, whatever its age
  const sinceTargets = new Map<InstalledDep, string>()
  let unchanged = 0
  if (opts.since) {
    const base = await readBaseTree(root, opts.since)
    let baseInventory
    try {
      baseInventory = await buildInventory(
        base.dir,
        { prod: opts.prod },
        await listProjectFiles(base.dir)
      )
    } finally {
      await base.cleanup()
    }
    since = { ref: base.ref, commit: base.commit }
    const plan = planSince(targets, baseInventory, base.ref)
    targets = plan.changed.map((c) => c.dep)
    for (const c of plan.changed) sinceTargets.set(c.dep, c.to)
    unchanged = plan.unchanged
    notAnalyzed.push(...plan.added)
  }
  const scanned =
    targets.length > 0
      ? await scanUsage(ctx, root, files, inventory, (done, total) =>
          onEvent({ type: "files", done, total })
        )
      : emptyUsage()

  let upToDate = 0
  const briefs: PackageBrief[] = []
  onEvent({ type: "packages", total: targets.length })
  let finished = 0
  const analyse = async (dep: InstalledDep): Promise<void> => {
    const pack = await getPackument(ctx, cfg, dep.name)
    if (!pack.ok) {
      notAnalyzed.push({
        pkg: dep.name,
        reason: `registry: ${pack.reason}${pack.detail ? ` (${pack.detail})` : ""}`,
      })
      return
    }
    if (
      !pack.packument.versions[dep.version] &&
      !dep.flags.includes("not-in-registry")
    )
      dep.flags.push("not-in-registry")
    const spec = specs.find(
      (s) => s.name === dep.name || dep.declaredBy.some((b) => b.key === s.name)
    )
    const choice = selectCandidate(pack.packument, dep.version, {
      now: ctx.now,
      minAgeMs,
      ageExcluded: (v) => isAgeExcluded(cfg, dep.name, v),
      latest: opts.latest,
      ...(sinceTargets.has(dep)
        ? { explicit: sinceTargets.get(dep) }
        : spec?.version
          ? { explicit: spec.version }
          : {}),
    })
    if (choice.kind === "error") {
      notAnalyzed.push({ pkg: dep.name, reason: choice.reason })
      return
    }
    if (choice.kind === "up-to-date") {
      upToDate++
      return
    }
    const candidate = choice.candidate
    const usage = usageFor(scanned, dep, inventory.installed)

    const typesPackageInstalled = inventory.installed.some(
      (d) => d.name === typesPackageName(dep.name)
    )
    const disabled: SurfaceOutcome = { status: "disabled", touched: [] }
    const [notes, surface] = await Promise.all([
      opts.notes
        ? collectNotes(ctx, cfg, pack.packument, candidate)
        : Promise.resolve(undefined),
      opts.surface
        ? analyzeSurface(ctx, cfg, pack.packument, candidate, usage, {
            typesPackageInstalled,
          }).catch((error: unknown): SurfaceOutcome => ({
            status: "failed",
            detail: String(error).slice(0, 200),
            touched: [],
          }))
        : Promise.resolve(disabled),
    ])
    const {
      blindSpots: surfaceBlind,
      options: typedOptions,
      ...surfaceOut
    } = surface
    // with types, the options a call accepts; without, the keys the code passes are the only clue
    const optionSites =
      surface.status === "computed"
        ? (typedOptions ?? {})
        : (usage?.passedOptions ?? {})
    const match = notes
      ? matchNotes(
          notes.entries,
          usage?.strongNames ?? [],
          usage?.weakNames ?? [],
          {
            accepted: Object.keys(optionSites),
            typesRead: surface.status === "computed",
          }
        )
      : undefined
    // what the notes radius cannot tie by name may still reach, through the package's own code
    const unplaced = match
      ? [...match.unattributedBreaking, ...match.unattributedChanges]
      : []
    const hints =
      unplaced.length > 0
        ? await implementationHints(
            ctx,
            cfg,
            pack.packument,
            candidate,
            usage,
            unplaced
          )
        : undefined
    if (hints && hints.status !== "computed")
      ctx.log.debug(`${dep.name}: no code hints, ${hints.detail}`)
    const merged =
      usage && surfaceBlind
        ? { ...usage, blindSpots: [...usage.blindSpots, ...surfaceBlind] }
        : usage
    briefs.push(
      buildPackageBrief({
        dep,
        candidate,
        usage: merged,
        surface: surfaceOut,
        notes,
        match,
        notesDisabled: !opts.notes,
        optionSites,
        ...(hints?.status === "computed" ? { hints: hints.hints } : {}),
      })
    )
  }
  await Promise.all(
    targets.map((dep) => {
      onEvent({ type: "package-start", name: dep.name })
      return analyse(dep).finally(() => {
        finished++
        onEvent({
          type: "package",
          name: dep.name,
          done: finished,
          total: targets.length,
        })
      })
    })
  )

  briefs.sort(
    (a, b) => a.pkg.localeCompare(b.pkg) || semver.compare(a.from, b.from)
  )
  const exitCode = briefs.some((b) => b.verdict === "blocked")
    ? 2
    : briefs.some((b) => b.verdict === "review")
      ? 1
      : 0
  return {
    schemaVersion: 1,
    tool: { version: toolVersion(), typescript: ts.version },
    root,
    generatedAt: new Date(ctx.now).toISOString(),
    ...(since ? { since } : {}),
    manifests: inventory.manifests.length,
    packages: briefs,
    upToDate: upToDate + unchanged,
    notAnalyzed: dedupeNotAnalyzed(notAnalyzed),
    global: scanned.global,
    limits: limitsFor(briefs, scanned.global),
    exitCode,
  }
}

// @types/X is used exactly where X is used.
function usageFor(
  scanned: UsageMap,
  dep: InstalledDep,
  installed: InstalledDep[]
): PackageUsage | undefined {
  const own = scanned.packages[dep.id]
  if (!dep.name.startsWith("@types/")) return own
  const bare = dep.name.slice("@types/".length)
  const target = bare.includes("__") ? `@${bare.replace("__", "/")}` : bare
  const sources = Object.values(scanned.packages).filter(
    (p) => p.pkg === target || (target === "node" && p.pkg.startsWith("node:"))
  )
  if (sources.length === 0) {
    const exists = installed.some((d) => d.name === target)
    return {
      installedId: dep.id,
      pkg: dep.name,
      refs: own?.refs ?? [],
      strongNames: own?.strongNames ?? [],
      weakNames: own?.weakNames ?? [],
      files: own?.files ?? 0,
      blindSpots: own?.blindSpots ?? [],
      opaque: [
        ...(own?.opaque ?? []),
        {
          kind: "ambient-types",
          count: 1,
          examples: [
            {
              file: dep.declaredBy[0]?.manifest ?? "package.json",
              line: 1,
              col: 1,
              typeOnly: true,
              text: exists
                ? `types for ${target}, which no scanned file imports`
                : "ambient types",
            },
          ],
        },
      ],
    }
  }
  const merged: PackageUsage = {
    installedId: dep.id,
    pkg: dep.name,
    refs: sources.flatMap((s) => s.refs),
    strongNames: [...new Set(sources.flatMap((s) => s.strongNames))].sort(),
    weakNames: [...new Set(sources.flatMap((s) => s.weakNames))].sort(),
    files: sources.reduce((n, s) => n + s.files, 0),
    blindSpots: sources.flatMap((s) => s.blindSpots),
    opaque: [...(own?.opaque ?? [])],
  }
  return merged
}

function typesPackageName(name: string): string {
  return name.startsWith("@")
    ? `@types/${name.slice(1).replace("/", "__")}`
    : `@types/${name}`
}

function emptyUsage(): UsageMap {
  return { scannedFiles: 0, packages: {}, global: [] }
}

function dedupeNotAnalyzed(list: NotAnalyzed[]): NotAnalyzed[] {
  const seen = new Map<string, NotAnalyzed>()
  for (const n of list) if (!seen.has(n.pkg)) seen.set(n.pkg, n)
  return [...seen.values()].sort((a, b) => a.pkg.localeCompare(b.pkg))
}
