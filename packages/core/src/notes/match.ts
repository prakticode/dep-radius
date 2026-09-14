import type { NoteEntry, NoteHit, NoteMatch, RegionKind } from "../model.ts"

// No dictionaries. A name that looks like code matches as a token anywhere; a plain English word
// matches only where it is written as code: `.email`, `email(`, `email<`, `<Email`.

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

// A breaking entry that names an API is about that API; when it is not one of yours, it is someone
// else's break. One that names nothing ("drops Node 18", "ESM only") can be anyone's.
function namesAnApi(e: NoteEntry): boolean {
  const headline = e.regions.filter(
    (r) => r.kind === "title" || r.kind === "inline-code"
  )
  return headline.some(
    (r) => r.kind === "inline-code" || /[\w$]\(\)|\.[a-z]\w*\(/i.test(r.text)
  )
}

export interface MatchResult {
  matched: NoteMatch[]
  unattributedBreaking: NoteEntry[]
  total: number
}

export interface MatchOptions {
  // share of the entries with examples a name must appear in before its examples stop counting;
  // Infinity turns demotion off (the backtest measures what it removes)
  demoteShare?: number
  // option names the functions you call accept, from their types: a note about a default lands on
  // the calls that never pass it
  accepted?: string[]
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

function camelCase(header: string): string {
  return header
    .toLowerCase()
    .split("-")
    .map((part, i) =>
      i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join("")
}

export const DEMOTE_SHARE = 0.25

export function matchNotes(
  entries: NoteEntry[],
  strong: string[],
  weak: string[],
  options: MatchOptions = {}
): MatchResult {
  const share = options.demoteShare ?? DEMOTE_SHARE
  // `h` of `{ h, s, l }` is a letter in any note, not an option anyone writes about
  const accepted = (options.accepted ?? []).filter(
    (name) => name.length >= 3 && !strong.includes(name) && !weak.includes(name)
  )
  const live = entries.filter((e) => !e.noise)
  const names = [
    ...strong.map((name) => ({ name, strength: "strong" as const })),
    ...weak
      .filter((w) => !strong.includes(w))
      .map((name) => ({ name, strength: "weak" as const })),
  ].map((n) => ({ ...n, re: patternFor(n.name) }))

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

  const matched: NoteMatch[] = []
  const unattributedBreaking: NoteEntry[] = []
  for (const e of live) {
    const hits: NoteHit[] = []
    const scope = scopeOf(e)
    for (const n of names) {
      let hitRegion: RegionKind | undefined =
        n.name.length >= 3 && n.name === scope ? "title" : undefined
      for (const r of hitRegion ? [] : e.regions) {
        if (
          r.kind === "code-block" &&
          // demotion never silences a breaking entry: one whose only link to the code is its example
          // is still a break
          ((demoted.has(n.name) && !e.breakingMarker) ||
            (n.strength === "weak" && !isCodeShaped(n.name)))
        )
          continue
        if (n.re.test(r.text)) {
          hitRegion = r.kind
          break
        }
      }
      if (hitRegion)
        hits.push({ name: n.name, strength: n.strength, region: hitRegion })
    }
    for (const name of accepted) {
      const region = optionHit(name, e)
      if (region) hits.push({ name, strength: "weak", region, option: true })
    }
    if (hits.length > 0)
      matched.push({
        entry: e,
        hits,
        direct: hits.some(
          (h) => h.strength === "strong" && h.region !== "code-block"
        ),
      })
    else if (e.breakingMarker && !namesAnApi(e)) unattributedBreaking.push(e)
  }
  matched.sort(
    (a, b) =>
      Number(b.direct) - Number(a.direct) ||
      Number(b.entry.breakingMarker) - Number(a.entry.breakingMarker)
  )
  return { matched, unattributedBreaking, total: live.length }
}
