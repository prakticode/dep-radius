import { UNSEEN_LABEL } from "../labels.ts"
import type {
  InstalledDep,
  PackageBrief,
  PackageUsage,
  Verdict,
  VerdictReason,
} from "../model.ts"

export interface VerdictInput {
  bump: PackageBrief["bump"]
  zeroMajor: boolean
  flags: InstalledDep["flags"]
  usage: PackageUsage | undefined
  surface: PackageBrief["surface"] & { incomplete?: boolean }
  notes: PackageBrief["notes"]
}

// Evaluated in order, every rule that fires is kept as a reason. The one outcome that must never
// happen is a wrong "quiet", so anything the tool cannot see pushes towards review.
export function decide(input: VerdictInput): {
  verdict: Verdict
  reasons: VerdictReason[]
} {
  const reasons: VerdictReason[] = []
  const { usage, surface, notes } = input

  const strongRemoved = surface.touched.filter(
    (t) => t.bucket === "removed" && t.strength === "strong"
  )
  if (surface.status === "computed" && strongRemoved.length > 0) {
    reasons.push({
      code: "removed-touched",
      detail: `${strongRemoved.length} removed ${plural(strongRemoved.length, "export")} you use: ${names(strongRemoved.map((t) => t.change.path))}`,
    })
  }

  const changed = surface.touched.filter(
    (t) => t.bucket === "changed" && t.strength === "strong"
  )
  if (changed.length > 0)
    reasons.push({
      code: "changed-touched",
      detail: `${changed.length} changed ${plural(changed.length, "signature")} you use: ${names(changed.map((t) => t.change.path))}`,
    })
  const deprecated = surface.touched.filter(
    (t) => t.bucket === "deprecated" && t.strength === "strong"
  )
  if (deprecated.length > 0)
    reasons.push({
      code: "deprecated-touched",
      detail: `${deprecated.length} newly deprecated: ${names(deprecated.map((t) => t.change.path))}`,
    })
  const weak = surface.touched.filter((t) => t.strength === "weak")
  if (weak.length > 0)
    reasons.push({
      code: "possibly-touched",
      detail: `${weak.length} changed ${plural(weak.length, "member")} you may reach by name: ${names(weak.map((t) => t.change.path))}`,
    })

  if (notes.matched.length > 0) {
    const direct = notes.matched.filter((m) => m.direct).length
    reasons.push({
      code: "notes-match",
      detail: `${notes.matched.length} release ${plural(notes.matched.length, "note")} ${notes.matched.length === 1 ? "mentions" : "mention"} names you use (${direct} by name in the text)`,
    })
  }
  if (notes.unattributedBreaking.length > 0) {
    reasons.push({
      code: "unattributed-breaking",
      detail: `${notes.unattributedBreaking.length} breaking ${plural(notes.unattributedBreaking.length, "note")} naming no API, which can apply to anyone`,
    })
  }
  // a fix or a change nothing ties to the code may still be about it: quiet cannot ignore it
  const unplaced = notes.unattributedChanges.length
  if (unplaced > 0) {
    reasons.push({
      code: "unattributed-change",
      detail: `${unplaced} release ${plural(unplaced, "note")} ${unplaced === 1 ? "describes a change" : "describe changes"} radius cannot tie to your code`,
    })
  }

  const blind = usage?.blindSpots ?? []
  if (blind.length > 0)
    reasons.push({
      code: "blind-spots",
      detail: `usage not fully visible: ${blind.map((b) => `${b.count} ${UNSEEN_LABEL[b.kind] ?? b.kind}`).join(", ")}`,
    })
  const opaque = usage?.opaque ?? []
  if (opaque.length > 0)
    reasons.push({
      code: "opaque-usage",
      detail: `used in ways names cannot show: ${opaque.map((o) => UNSEEN_LABEL[o.kind] ?? o.kind).join(", ")}`,
    })
  if (
    !usage ||
    (usage.refs.length === 0 && opaque.length === 0 && blind.length === 0)
  ) {
    reasons.push({
      code: "not-referenced",
      detail:
        "not referenced by any scanned file; used by a tool, loaded by name, or unused",
    })
  }
  const flagged = input.flags.filter(
    (f) => f === "not-in-registry" || f === "patched" || f === "range-guess"
  )
  if (flagged.length > 0)
    reasons.push({
      code: "flagged-install",
      detail: `the installed copy is ${flagged.join(", ")}`,
    })

  // a wrapper's shape lives in the package it wraps: no types of its own is not the same as no shape
  if (
    surface.status === "failed" ||
    surface.status === "offline-uncached" ||
    surface.status === "types-elsewhere" ||
    surface.incomplete
  ) {
    reasons.push({
      code: "surface-incomplete",
      detail: surface.detail ?? `type surface ${surface.status}`,
    })
  }
  const notesComplete = notes.coverage === "complete"
  const surfaceComputed = surface.status === "computed"
  if (!notesComplete && !surfaceComputed) {
    reasons.push({
      code: "no-evidence",
      detail: `neither net is complete: notes ${notes.coverage}, types ${surface.status}`,
    })
  }
  const bothClean =
    notesComplete &&
    surfaceComputed &&
    surface.touched.length === 0 &&
    notes.matched.length === 0 &&
    notes.unattributedBreaking.length === 0 &&
    notes.unattributedChanges.length === 0
  if ((input.bump === "major" || input.zeroMajor) && !bothClean) {
    reasons.push({
      code: "major-unproven",
      detail: `a ${input.zeroMajor ? "0.x minor, a major by convention" : "major"} is only quiet when both nets are complete and clean`,
    })
  }

  let verdict: Verdict = "quiet"
  if (reasons.some((r) => r.code === "removed-touched")) verdict = "blocked"
  else if (reasons.length > 0) verdict = "review"
  else {
    if (notesComplete)
      reasons.push({
        code: "notes-complete-no-match",
        detail:
          "every release note read: none mentions what you use, and none changes something radius cannot place",
      })
    if (surfaceComputed)
      reasons.push({
        code: "surface-clean",
        detail: "no changed or removed export you use",
      })
    if (!surfaceComputed)
      reasons.push({
        code: "caveat-no-types",
        detail:
          "no type surface: shape changes were judged from the notes alone",
      })
    if (!notesComplete)
      reasons.push({
        code: "caveat-no-notes",
        detail: "no release notes: behaviour changes are invisible here",
      })
  }
  return { verdict, reasons }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

function names(paths: string[]): string {
  const shown = paths.slice(0, 4).join(", ")
  return paths.length > 4 ? `${shown} and ${paths.length - 4} more` : shown
}
