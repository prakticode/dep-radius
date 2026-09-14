import type { CanonPath, EntryKind, RegionKind } from "../model.ts"

// What a release note entry says, read once and kept as data. Linking a note to the code is then
// a join of what the record names with what the project uses; nothing downstream reads the note's
// words again.

// A record file written under another schema is ignored, never half read.
export const RECORD_SCHEMA = 1

export interface ChangeRecord {
  schema: typeof RECORD_SCHEMA
  // the NoteEntry id the record reads
  entry: string
  version: string
  kind: EntryKind
  breaking: boolean
  // the APIs the change is about, each one in the package's type surface:
  // "lib:watch", "lib:Parser#parse", or an option a call takes, "lib:Parser{strict}"
  subjects: Subject[]
  // names the note writes, where it writes them: what the rules find without knowing any API
  mentions?: Mention[]
  // how the note names an API at all: in its headline, anywhere in its text, or not
  namesApi?: "headline" | "text" | "none"
  what: string
  source: "rules" | "ai"
  confidence?: number
  // which extractor, at which version, made the record: "rules@1", "ai:<model>:<prompt version>"
  extractor: string
}

export type Subject = string

export interface Mention {
  name: string
  // the kinds of the regions it is written in, each kind once, in the order the entry has them
  regions: RegionKind[]
  // the title's commit scope names it: `diff: fix ...`, `fix(diff): ...`
  scope?: true
  // written in the examples of so many entries that the examples say nothing about it
  boilerplate?: true
  // an option name, found by the option rules
  option?: true
}

// "lib:Parser{strict}" is the option strict of what lib:Parser takes; "lib:watch" is the API itself.
export function parseSubject(subject: Subject): {
  path: CanonPath
  option?: string
} {
  const m = /^(.*)\{([^{}]+)\}$/.exec(subject)
  return m ? { path: m[1]!, option: m[2]! } : { path: subject }
}

export function formatSubject(path: CanonPath, option?: string): Subject {
  return option === undefined ? path : `${path}{${option}}`
}
