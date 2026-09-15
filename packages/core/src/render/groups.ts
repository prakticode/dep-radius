import { UNSEEN_LABEL } from "../labels.ts"
import { lastName } from "../symbol-path.ts"
import type {
  Brief,
  NoteHit,
  NoteMatch,
  PackageBrief,
  Site,
  Touched,
  UnplacedEntry,
} from "../model.ts"

// reasons that say "the tool cannot see", as opposed to "something changed that you use"
const UNSEEN = new Set([
  "opaque-usage",
  "not-referenced",
  "blind-spots",
  "no-evidence",
  "flagged-install",
  "surface-incomplete",
])

// a quiet brief that stood on one net: said next to its name, not only in the JSON
export function oneNetOnly(p: PackageBrief): boolean {
  return p.reasons.some(
    (r) => r.code === "caveat-no-types" || r.code === "caveat-no-notes"
  )
}

export interface Groups {
  detailed: PackageBrief[]
  quiet: PackageBrief[]
  unseen: PackageBrief[]
}

// Review briefs whose only reason is "cannot see how you use it" are listed on one line each: a full
// block per linter plugin would bury the packages that actually changed under you.
export function groupBriefs(brief: Brief): Groups {
  const order = { blocked: 0, review: 1, quiet: 2 }
  const sorted = [...brief.packages].sort(
    (a, b) => order[a.verdict] - order[b.verdict] || a.pkg.localeCompare(b.pkg)
  )
  return {
    detailed: sorted.filter((p) => p.verdict !== "quiet" && !isUnseenOnly(p)),
    quiet: sorted.filter((p) => p.verdict === "quiet"),
    unseen: sorted.filter((p) => p.verdict !== "quiet" && isUnseenOnly(p)),
  }
}

export function isUnseenOnly(p: PackageBrief): boolean {
  return (
    p.verdict === "review" &&
    p.reasons.every((r) => UNSEEN.has(r.code)) &&
    p.reasons.some((r) => r.code !== "no-evidence")
  )
}

export type Finding =
  | { kind: "type"; touched: Touched }
  | { kind: "note"; match: NoteMatch }
  | { kind: "breaking-no-api"; entry: UnplacedEntry }
  | { kind: "change-no-api"; entry: UnplacedEntry }

// a note the package's code ties to an export you use comes before the ones nothing ties, so a
// capped list keeps it
function hintedFirst(entries: UnplacedEntry[]): UnplacedEntry[] {
  return [
    ...entries.filter((e) => e.likely),
    ...entries.filter((e) => !e.likely),
  ]
}

// "src/store.ts:5, via setItem inside persist": where a note radius cannot tie by name probably
// lands, through the package's own code. The first export only, and its first site.
export function likelyLabel(
  e: UnplacedEntry,
  format: (name: string) => string = (name) => name
): string | undefined {
  const first = e.likely?.[0]
  const site = first?.sites[0]
  if (!first || !site) return undefined
  const more =
    first.sites.length > 1 ? ` (+${first.sites.length - 1} more)` : ""
  return `probably reaches: ${site.file}:${site.line}${more}, via ${first.via.map(format).join(", ")} inside ${format(lastName(first.export) || first.export)}`
}

// What a package's reader sees, most pressing first: what breaks and is tied to their code, then
// what is tied to it, then what may break, then what may concern them. Nothing is left out, and
// within a rank the type changes come before the notes, each in its own order.
export function orderFindings(p: PackageBrief): Finding[] {
  const rank = (f: Finding): number => {
    if (f.kind === "type") {
      if (f.touched.strength === "weak") return 5
      return f.touched.bucket === "removed" ? 0 : 1
    }
    if (f.kind === "breaking-no-api") return 4
    if (f.kind === "change-no-api") return 5
    // a note its author marks breaking, naming something you use even only by name, comes before
    // the ordinary fixes that name it exactly: a long upgrade has dozens of those
    if (f.match.entry.breakingMarker) return f.match.direct ? 0 : 2
    return f.match.direct ? 3 : 5
  }
  const all: Finding[] = [
    ...p.surface.touched.map((touched) => ({ kind: "type" as const, touched })),
    ...p.notes.matched.map((match) => ({ kind: "note" as const, match })),
    ...hintedFirst(p.notes.unattributedBreaking).map((entry) => ({
      kind: "breaking-no-api" as const,
      entry,
    })),
    ...hintedFirst(p.notes.unattributedChanges).map((entry) => ({
      kind: "change-no-api" as const,
      entry,
    })),
  ]
  // Array.prototype.sort is stable: equal ranks keep the order above
  return all.sort((a, b) => rank(a) - rank(b))
}

// What ties a note to the code: names the code uses, and options of the calls it makes, which a
// note about a default concerns even when the code never passes them.
export function usedLabel(
  hits: NoteHit[],
  format: (name: string) => string = (name) => name
): string {
  const list = (names: string[]) => [...new Set(names)].map(format).join(", ")
  const used = hits.filter((h) => !h.option).map((h) => h.name)
  const options = hits.filter((h) => h.option).map((h) => h.name)
  return [
    ...(used.length > 0 ? [`you use: ${list(used)}`] : []),
    ...(options.length > 0
      ? [`an option of a call you make: ${list(options)}`]
      : []),
  ].join("; ")
}

export function sitesFor(p: PackageBrief, names: string[]): Site[] {
  const seen = new Map<string, Site>()
  for (const n of names)
    for (const s of p.usage.byName[n] ?? []) seen.set(`${s.file}:${s.line}`, s)
  return [...seen.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  )
}

export function siteLabel(s: Site): string {
  const via =
    s.via && s.via.length > 0 ? `  (via ${s.via[s.via.length - 1]})` : ""
  return `${s.file}:${s.line}${s.typeOnly ? "  type" : ""}${via}`
}

export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return "unknown"
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

export function opaqueLabel(p: PackageBrief): string {
  const kinds = [
    ...p.usage.opaque.map((o) => o.kind),
    ...p.usage.blindSpots.map((b) => b.kind),
  ]
  const labels = [...new Set(kinds.map((k) => UNSEEN_LABEL[k] ?? k))]
  if (p.reasons.some((r) => r.code === "not-referenced"))
    labels.push("not referenced by any scanned file")
  for (const code of ["flagged-install", "surface-incomplete"]) {
    const r = p.reasons.find((x) => x.code === code)
    if (r) labels.push(r.detail)
  }
  return labels.join("; ")
}

export function coverageLabel(p: PackageBrief): string {
  const n = p.notes
  if (n.coverage === "disabled") return "notes disabled"
  const found = n.perVersion.filter((v) => v.status === "found").length
  const total = n.perVersion.length
  const sources = [
    ...new Set(n.perVersion.map((v) => v.source?.kind).filter(Boolean)),
  ].join(", ")
  if (n.coverage === "complete")
    return `notes for ${total}/${total} versions${sources ? ` (${sources})` : ""}`
  if (n.coverage === "partial")
    return `notes for ${found}/${total} versions${sources ? ` (${sources})` : ""}`
  if (n.coverage === "none-published")
    return "this author publishes no notes; behaviour changes are invisible here"
  const reasons = [
    ...new Set(n.perVersion.map((v) => v.reason).filter(Boolean)),
  ].join(", ")
  return `notes unavailable${reasons ? ` (${reasons})` : ""}`
}

export function surfaceLabel(p: PackageBrief): string {
  const s = p.surface
  switch (s.status) {
    case "computed":
      return `${s.changes ?? 0}`
    case "no-types":
      return `unknown (${s.detail ?? "no types"})`
    case "types-from-@types":
      return "unknown (types live in @types)"
    case "types-elsewhere":
      return "unknown (types re-exported from another package)"
    case "disabled":
      return s.detail ?? "not computed (--no-surface)"
    case "offline-uncached":
      return "unknown (offline, not cached)"
    case "failed":
      return `unknown (${s.detail ?? "extraction failed"})`
  }
}

// "main (8f74b3b)", or only the short hash when the ref already is a hash, as in a pull request
export function sinceLabel(since: NonNullable<Brief["since"]>): string {
  const short = since.commit.slice(0, 7)
  return since.commit.startsWith(since.ref) ? short : `${since.ref} (${short})`
}
