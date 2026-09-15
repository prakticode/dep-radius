import { RECORD_SCHEMA } from "./record.ts"
import type { NoteEntry, RegionKind } from "../model.ts"
import type { ChangeRecord, Mention } from "./record.ts"

// The records the rules make: which of a list of names an entry writes, and where. No dictionaries.
// A name that looks like code matches as a token anywhere; a plain English word matches only where
// it is written as code: `.email`, `email(`, `email<`, `<Email`.

export const RULES_EXTRACTOR = "rules@1"

// share of the entries with examples a name must appear in before its examples stop counting
export const DEMOTE_SHARE = 0.25

export function isCodeShaped(name: string): boolean {
  return /[A-Z_$0-9]/.test(name.slice(1)) || name.length >= 12
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function patternFor(name: string): RegExp {
  const n = escape(name)
  if (name.length <= 2) return new RegExp(`(?<=\\.)${n}(?![\\w$])`)
  if (isCodeShaped(name)) return new RegExp(`(?<![\\w$])${n}(?![\\w$])`)
  return new RegExp(
    `(?<=\\.)${n}(?![\\w$])|(?<![\\w$.])${n}(?=\\s*[(<])|(?<=<)${n}(?![\\w$])`
  )
}

const CALL_SHAPED = /[\w$]\(\)|\.[a-z]\w*\(/i

// A change that names an API somewhere is about that API; when it is not one of yours, it is
// someone else's.
function namesAnApi(e: NoteEntry): boolean {
  const headline = e.regions.filter(
    (r) => r.kind === "title" || r.kind === "inline-code"
  )
  return headline.some(
    (r) => r.kind === "inline-code" || CALL_SHAPED.test(r.text)
  )
}

// A breaking entry is someone else's break only when its headline names the API. A breaking section
// that mentions a few APIs in its text can describe other breaks too ("Option strict controls all
// strict mode restrictions"), so it stays a break that could apply to anyone.
function headlineNamesAnApi(e: NoteEntry): boolean {
  const end = e.regions.findIndex(
    (r) => r.kind === "prose" || r.kind === "code-block"
  )
  const headline = end < 0 ? e.regions : e.regions.slice(0, end)
  return headline.some(
    (r) => r.kind === "inline-code" || CALL_SHAPED.test(r.text)
  )
}

// An option is named in a note's words or code spans, never in its examples: as a code-shaped
// token (`returnNull`), as a whole code span (`quiet`, `quiet: true`) or the path to one of its own
// options (`retry.methods`), or as the header it sets (`Content-Security-Policy` for
// contentSecurityPolicy).
function optionHit(name: string, e: NoteEntry): RegionKind | undefined {
  const token = new RegExp(`(?<![\\w$-])${escape(name)}(?![\\w$-])`)
  const span = new RegExp(
    `^\\s*\\{?\\s*${escape(name)}\\s*(?:[?:=].*)?\\}?\\s*$`
  )
  const nested = new RegExp(`^\\s*${escape(name)}(?:\\.[\\w$]+)+\\s*$`)
  for (const r of e.regions) {
    if (r.kind === "code-block") continue
    if (isCodeShaped(name) && token.test(r.text)) return r.kind
    if (r.kind === "inline-code" && (span.test(r.text) || nested.test(r.text)))
      return r.kind
    for (const header of r.text.match(
      /[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/g
    ) ?? [])
      if (camelCase(header) === name) return r.kind
  }
  return undefined
}

// A commit title that starts with the API it changes, `diff: fix prerelease to stable` or
// `fix(diff): ...`, names that API even when the rest is plain words.
function scopeOf(e: NoteEntry): string | undefined {
  const title = e.title
    .replace(/^[0-9a-f]{7,40}\s+/, "")
    .replace(/^(?:#\d+\s+)+/, "")
  const m = /^(?:[a-z]+\(([\w$./-]+)\)!?|([\w$]+)):\s/.exec(title)
  return m?.[1] ?? m?.[2]
}

// A scope is the area a commit touched. When the rest of the title names the API that changed, as
// in `fix(model): make Model.bulkWrite() not throw` or `feat(connection): add withSession`, the scope
// is not the change, and a project using `model` is not concerned by it.
function titleNamesAnotherApi(e: NoteEntry, scope: string): boolean {
  const title = e.title
    .replace(/^[0-9a-f]{7,40}\s+/, "")
    .replace(/^(?:#\d+\s+)+/, "")
    .replace(/^[^:]*:\s/, "")
    .replace(/\bby @\S+.*$/, "")
    .replace(/@\S+/g, "")
    .replace(/#\d+/g, "")
    .replace(/\([0-9a-f]{5,}\)/g, "")
  if (CALL_SHAPED.test(title)) return true
  const end = e.regions.findIndex(
    (r) => r.kind === "prose" || r.kind === "code-block"
  )
  const headline = end < 0 ? e.regions : e.regions.slice(0, end)
  // a code span holding a commit hash or an issue number is a reference, not an API
  if (
    headline.some(
      (r) =>
        r.kind === "inline-code" &&
        !/^\s*(?:[0-9a-f]{7,40}|#\d+)\s*$/.test(r.text)
    )
  )
    return true
  // an identifier written in plain words: camelCase, snake_case or long; not an acronym or a
  // capitalised word
  return (title.match(/[A-Za-z_$][\w$]*/g) ?? []).some(
    (w) =>
      w !== scope &&
      isCodeShaped(w) &&
      !/^[A-Z]+$/.test(w) &&
      !/^[A-Z][a-z]+$/.test(w)
  )
}

function camelCase(header: string): string {
  return header
    .toLowerCase()
    .split("-")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join("")
}

export interface Vocabulary {
  // the names to look for as code
  names: string[]
  // the option names to look for
  options: string[]
}

export interface RulesOptions {
  // Infinity turns demotion off (the backtest measures what it removes)
  demoteShare?: number
}

// One record per entry that is not housekeeping.
export function rulesRecords(
  entries: NoteEntry[],
  vocabulary: Vocabulary,
  options: RulesOptions = {}
): ChangeRecord[] {
  const share = options.demoteShare ?? DEMOTE_SHARE
  const live = entries.filter((e) => !e.noise)
  const names = [...new Set(vocabulary.names)].map((name) => ({
    name,
    re: patternFor(name),
  }))

  // a name found in the examples of many entries is example boilerplate, not news: `v.object()` in
  // every snippet of a release says nothing about v.object
  const withCode = live.filter((e) =>
    e.regions.some((r) => r.kind === "code-block")
  )
  const demoted = new Set<string>()
  for (const n of names) {
    const inCode = withCode.filter((e) =>
      e.regions.some((r) => r.kind === "code-block" && n.re.test(r.text))
    ).length
    if (inCode >= 3 && inCode >= withCode.length * share) demoted.add(n.name)
  }

  return live.map((e): ChangeRecord => {
    const titleScope = scopeOf(e)
    const scope =
      titleScope && !titleNamesAnotherApi(e, titleScope)
        ? titleScope
        : undefined
    const mentions: Mention[] = []
    for (const n of names) {
      const regions: RegionKind[] = []
      for (const r of e.regions)
        if (!regions.includes(r.kind) && n.re.test(r.text)) regions.push(r.kind)
      const scoped = n.name.length >= 3 && n.name === scope
      if (regions.length === 0 && !scoped) continue
      mentions.push({
        name: n.name,
        regions,
        ...(scoped ? { scope: true as const } : {}),
        ...(demoted.has(n.name) ? { boilerplate: true as const } : {}),
      })
    }
    for (const name of new Set(vocabulary.options)) {
      const region = optionHit(name, e)
      if (region) mentions.push({ name, regions: [region], option: true })
    }
    return {
      schema: RECORD_SCHEMA,
      entry: e.id,
      version: e.version,
      kind: e.kind,
      breaking: e.breakingMarker,
      subjects: [],
      mentions,
      namesApi: headlineNamesAnApi(e)
        ? "headline"
        : namesAnApi(e)
          ? "text"
          : "none",
      what: e.title,
      source: "rules",
      extractor: RULES_EXTRACTOR,
    }
  })
}
