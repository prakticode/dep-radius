import { isCodeShaped } from "./rules.ts"
import { lastName } from "../symbol-path.ts"
import { type ChangeRecord, type Mention, parseSubject } from "./record.ts"
import type {
  CanonPath,
  NoteEntry,
  NoteHit,
  NoteMatch,
  RegionKind,
  Site,
} from "../model.ts"

export interface MatchResult {
  matched: NoteMatch[]
  unattributedBreaking: NoteEntry[]
  // changes nothing ties to the code: a fix or a change that names no API, or names one radius
  // cannot place without types. Each one is a note quiet would have to ignore
  unattributedChanges: NoteEntry[]
  total: number
}

// What the project uses, as the join reads it.
export interface ProjectUse {
  strong: string[]
  weak: string[]
  // option names the functions you call accept, already cleared of the names above
  accepted: string[]
  // the package's types were read, so a note naming an API radius does not see you use is about
  // someone else's API; without them, it may be an option or a member the scan cannot tell apart
  typesRead: boolean
  // the APIs the code reaches, resolved against the installed version's types, with their sites
  paths?: Record<CanonPath, Site[]>
}

// The records of each entry against what the project uses: a note whose record names something
// you use is matched, one that names nothing radius can place is unattributed.
export function joinRecords(
  entries: NoteEntry[],
  records: ChangeRecord[],
  use: ProjectUse
): MatchResult {
  const byEntry = new Map<string, ChangeRecord[]>()
  for (const r of records)
    byEntry.set(r.entry, [...(byEntry.get(r.entry) ?? []), r])
  const live = entries.filter((e) => !e.noise)
  const names = [
    ...use.strong.map((name) => ({ name, strength: "strong" as const })),
    ...use.weak
      .filter((w) => !use.strong.includes(w))
      .map((name) => ({ name, strength: "weak" as const })),
  ]

  const matched: NoteMatch[] = []
  const unattributedBreaking: NoteEntry[] = []
  const unattributedChanges: NoteEntry[] = []
  for (const e of live) {
    const own = byEntry.get(e.id) ?? []
    // what the rules read of the entry itself; other records only add subjects
    const rules = own.find((r) => r.source === "rules")
    const mentions = new Map<string, Mention>()
    const options = new Map<string, Mention>()
    for (const m of rules?.mentions ?? [])
      (m.option ? options : mentions).set(m.name, m)
    const breaking = rules?.breaking ?? e.breakingMarker

    const hits: NoteHit[] = []
    for (const n of names) {
      const m = mentions.get(n.name)
      if (!m) continue
      const region: RegionKind | undefined = m.scope
        ? "title"
        : m.regions.find(
            (kind) =>
              kind !== "code-block" ||
              // demotion never silences a breaking entry: one whose only link to the code is its
              // example is still a break
              !(
                (m.boilerplate && !breaking) ||
                (n.strength === "weak" && !isCodeShaped(n.name))
              )
          )
      if (region) hits.push({ name: n.name, strength: n.strength, region })
    }
    for (const name of use.accepted) {
      const region = options.get(name)?.regions[0]
      if (region) hits.push({ name, strength: "weak", region, option: true })
    }

    const subjects = [...new Set(own.flatMap((r) => r.subjects))].sort()
    for (const subject of subjects) {
      const hit = subjectHit(subject, use)
      if (hit && !hits.some((h) => h.name === hit.name)) hits.push(hit)
    }
    // A record only ever adds a tie. Subjects none of which the code reaches do not make a change
    // someone else's: a record can name the type of an options object (`ThrottleConfig`) rather
    // than the call that takes it, or one of the paths an API is exported at, and the change would
    // then leave the update quiet on a note about code the project uses.

    const namesApi = rules?.namesApi ?? "none"
    const kind = rules?.kind ?? e.kind
    if (hits.length > 0)
      matched.push({
        entry: e,
        hits,
        direct: hits.some(
          (h) => h.strength === "strong" && h.region !== "code-block"
        ),
      })
    else if (breaking && namesApi !== "headline") unattributedBreaking.push(e)
    else if (kind === "change" && (namesApi === "none" || !use.typesRead))
      unattributedChanges.push(e)
  }
  // breaking first, then exact: the order an agent reading the JSON meets them in
  matched.sort(
    (a, b) =>
      Number(b.entry.breakingMarker) - Number(a.entry.breakingMarker) ||
      Number(b.direct) - Number(a.direct)
  )
  return {
    matched,
    unattributedBreaking,
    unattributedChanges,
    total: live.length,
  }
}

// A subject lands on the code that reaches its API, or anything under it. Without types there are
// no paths, only names: the last name of the API, or the option. A record's subjects are what a
// reader or a model understood, never the note's own words, so the hit is never direct.
function subjectHit(subject: string, use: ProjectUse): NoteHit | undefined {
  const { path, option } = parseSubject(subject)
  const name = option ?? lastName(path)
  const hit: NoteHit = {
    name,
    strength: "weak",
    region: "prose",
    ...(option ? { option: true as const } : {}),
    subject,
  }
  if (use.paths) return reaches(use.paths, path) ? hit : undefined
  const named = (n: string) => use.strong.includes(n) || use.weak.includes(n)
  if (named(name) || (option !== undefined && use.accepted.includes(option)))
    return hit
  // an option nobody passes still lands on the calls of the API that takes it
  const api = lastName(path)
  return option !== undefined && api && named(api)
    ? { name: api, strength: "weak", region: "prose", subject }
    : undefined
}

function reaches(paths: Record<CanonPath, Site[]>, path: CanonPath): boolean {
  return Object.keys(paths).some((p) => isUnder(p, path))
}

function isUnder(used: CanonPath, path: CanonPath): boolean {
  return (
    used === path || used.startsWith(`${path}.`) || used.startsWith(`${path}#`)
  )
}

// The sites a hit from a subject lands on, for the names the usage scan does not already know.
export function subjectSites(
  matched: NoteMatch[],
  paths: Record<CanonPath, Site[]> | undefined
): Record<string, Site[]> {
  const out: Record<string, Site[]> = {}
  if (!paths) return out
  for (const m of matched)
    for (const h of m.hits) {
      if (!h.subject) continue
      const { path } = parseSubject(h.subject)
      for (const [p, sites] of Object.entries(paths))
        if (isUnder(p, path)) out[h.name] = [...(out[h.name] ?? []), ...sites]
    }
  return out
}
