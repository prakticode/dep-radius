import { isCodeShaped } from "./rules.ts"
import type { ChangeRecord, Mention } from "./record.ts"
import type { NoteEntry, NoteHit, NoteMatch, RegionKind } from "../model.ts"

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
    const mentions = new Map<string, Mention>()
    const options = new Map<string, Mention>()
    for (const r of own)
      for (const m of r.mentions ?? [])
        (m.option ? options : mentions).set(m.name, m)
    const breaking = own[0]?.breaking ?? e.breakingMarker

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

    const namesApi = own.find((r) => r.namesApi)?.namesApi ?? "none"
    const kind = own[0]?.kind ?? e.kind
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
  matched.sort(
    (a, b) =>
      Number(b.direct) - Number(a.direct) ||
      Number(b.entry.breakingMarker) - Number(a.entry.breakingMarker)
  )
  return {
    matched,
    unattributedBreaking,
    unattributedChanges,
    total: live.length,
  }
}
