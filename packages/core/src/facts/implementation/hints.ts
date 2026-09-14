import semver from "semver"

import { shortName } from "./graph.ts"
import type { Ctx } from "../../options.ts"
import { getImplementationPair } from "./load.ts"
import { uniqueSites } from "../../analyze/brief.ts"
import { codeNames } from "../../notes/code-names.ts"
import type { Packument } from "../../registry/packument.ts"
import type { RegistryConfig } from "../../registry/npmrc.ts"
import { reachableEntryExports, usedExports } from "./used.ts"
import type {
  ImplementationDiff,
  ImplementationFacts,
  ImplementationFlag,
} from "./model.ts"
import type {
  Candidate,
  CanonPath,
  LikelyReach,
  NoteEntry,
  PackageUsage,
} from "../../model.ts"

// Past this share of changed exports among those the project could use, every name in every note
// lands on changed code: a refactor of a shared core changes everything that reaches it. Measured on
// the behaviour change benchmark, where patches change a median 17% and minors and majors 67-75%.
export const HINT_CHANGED_SHARE = 0.25

// an export or a unit a note names through many exports is about the shared core, not one of them
const MAX_EXPORTS_PER_NOTE = 3

// a capped build misses code, so what it says changed is a guess on a guess
const CAPS: ImplementationFlag[] = ["file-cap", "unit-cap", "work-cap"]

export type HintOutcome =
  | { status: "computed"; hints: Map<string, LikelyReach[]>; share: number }
  | {
      status: "skipped" | "too-many-changed" | "failed"
      detail: string
      share?: number
    }

export interface HintInput {
  pkg: string
  usage: PackageUsage
  from: ImplementationFacts
  to: ImplementationFacts
  diff: ImplementationDiff
  entries: NoteEntry[]
  // HINT_CHANGED_SHARE unless a measurement asks for another
  maxChangedShare?: number
}

// The near rule: a note is linked to a used export whose code changed when one of its code names is
// a changed unit under that export, a member that unit reads, or a function that unit calls.
export function linkHints(input: HintInput): HintOutcome {
  const { pkg, usage, from, to, diff, entries } = input
  const capped = diff.flags.filter((f) => CAPS.includes(f))
  if (capped.length > 0)
    return { status: "skipped", detail: `capped: ${capped.join(", ")}` }

  const changed = new Map(diff.changed.map((c) => [c.path, c.units]))
  const could = reachableEntryExports(pkg, usage.refs, from)
  if (could.length === 0)
    return { status: "skipped", detail: "no export the project could use" }
  // over the whole package and over the entry points the project imports, whichever changed more:
  // a module export that reaches the whole package is noisy even when its entry has few exports
  const share = Math.max(
    could.filter((p) => changed.has(p)).length / could.length,
    diff.changed.length / (diff.changed.length + diff.unchanged || 1)
  )
  if (share > (input.maxChangedShare ?? HINT_CHANGED_SHARE))
    return {
      status: "too-many-changed",
      detail: `${Math.round(share * 100)}% of the exports the project could use changed`,
      share,
    }

  const used = usedExports(pkg, usage.refs, from)
  const unitsByName = [from, to].map((f) => {
    const m = new Map<string, number[]>()
    f.units.forEach((u, i) => m.set(u.name, [...(m.get(u.name) ?? []), i]))
    return m
  })
  // name -> the used exports whose changed code has that name
  const exportsByName = new Map<string, Set<CanonPath>>()
  const add = (name: string, path: CanonPath) => {
    const set = exportsByName.get(name) ?? new Set()
    set.add(path)
    exportsByName.set(name, set)
  }
  for (const path of used.keys()) {
    for (const unit of changed.get(path) ?? []) {
      add(shortName(unit), path)
      ;[from, to].forEach((f, side) => {
        for (const i of unitsByName[side]!.get(unit) ?? []) {
          const u = f.units[i]!
          for (const m of u.members) add(m, path)
          for (const c of u.calls) add(shortName(f.units[c]!.name), path)
        }
      })
    }
  }

  const hints = new Map<string, LikelyReach[]>()
  if (exportsByName.size === 0) return { status: "computed", hints, share }
  for (const e of entries) {
    const byExport = new Map<CanonPath, string[]>()
    for (const name of codeNames(e))
      for (const path of exportsByName.get(name) ?? [])
        byExport.set(path, [...(byExport.get(path) ?? []), name])
    if (byExport.size === 0 || byExport.size > MAX_EXPORTS_PER_NOTE) continue
    hints.set(
      e.id,
      [...byExport.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, via]) => ({
          export: path,
          via,
          sites: uniqueSites(used.get(path) ?? []),
        }))
    )
  }
  return { status: "computed", hints, share }
}

// Reads both versions' code from the cached tarballs and links the notes radius cannot tie to the
// code by name. Only for a package the project uses by name, and only when a note has a code name to
// link: a failure is a skipped hint, never an error.
export async function implementationHints(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  c: Candidate,
  usage: PackageUsage | undefined,
  entries: NoteEntry[]
): Promise<HintOutcome> {
  if (!usage || usage.refs.length === 0)
    return { status: "skipped", detail: "no named usage" }
  // a major rewrites shared code, so the gate below turns it off anyway: not worth reading its code
  if (c.bump === "major" || (semver.major(c.from) === 0 && c.bump === "minor"))
    return { status: "skipped", detail: "a major" }
  const named = entries.filter((e) => codeNames(e).length > 0)
  if (named.length === 0)
    return { status: "skipped", detail: "no note names code" }
  try {
    const pair = await getImplementationPair(ctx, cfg, p, c.from, c.to)
    if (!pair.ok)
      return {
        status: "failed",
        detail: `${pair.reason}${pair.detail ? ` (${pair.detail})` : ""}`,
      }
    return linkHints({
      pkg: p.name,
      usage,
      from: pair.from,
      to: pair.to,
      diff: pair.diff,
      entries: named,
    })
  } catch (error) {
    return { status: "failed", detail: String(error).slice(0, 200) }
  }
}
