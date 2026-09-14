import type { ChangeRecord } from "../records/record.ts"
import type { CanonPath, NoteEntry, Site } from "../model.ts"
import { joinRecords, type MatchResult } from "../records/join.ts"
import { DEMOTE_SHARE, isCodeShaped, rulesRecords } from "../records/rules.ts"

// Notes to the code in two steps: the rules read each entry into a record of the names it writes,
// then the records are joined with what the project uses.

export { DEMOTE_SHARE, isCodeShaped, type MatchResult }

export interface MatchOptions {
  // share of the entries with examples a name must appear in before its examples stop counting;
  // Infinity turns demotion off (the backtest measures what it removes)
  demoteShare?: number
  // option names the functions you call accept, from their types: a note about a default lands on
  // the calls that never pass it
  accepted?: string[]
  // the package's types were read, so a note naming an API radius does not see you use is about
  // someone else's API; without them, it may be an option or a member the scan cannot tell apart
  typesRead?: boolean
  // records made outside the run, already validated: their subjects join with the paths below
  records?: ChangeRecord[]
  // the APIs the code reaches, from the types, with their sites
  paths?: Record<CanonPath, Site[]>
}

export function matchNotes(
  entries: NoteEntry[],
  strong: string[],
  weak: string[],
  options: MatchOptions = {}
): MatchResult {
  // `h` of `{ h, s, l }` is a letter in any note, not an option anyone writes about
  const accepted = (options.accepted ?? []).filter(
    (name) => name.length >= 3 && !strong.includes(name) && !weak.includes(name)
  )
  const records = rulesRecords(
    entries,
    { names: [...strong, ...weak], options: accepted },
    { demoteShare: options.demoteShare }
  )
  return joinRecords(entries, [...records, ...(options.records ?? [])], {
    strong,
    weak,
    accepted,
    typesRead: options.typesRead ?? true,
    ...(options.paths ? { paths: options.paths } : {}),
  })
}
