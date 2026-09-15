import type { MatchResult } from "./join.ts"
import { entryPrefix, formatPath, lastName, parsePath } from "../symbol-path.ts"
import type {
  CanonPath,
  NoteEntry,
  NoteMatch,
  Surface,
  Touched,
} from "../model.ts"

// A breaking note that names no API can still say what went: "Remove Deprecated Legacy Namespace
// Support". When the types show that kind of thing gone, and the project using it, the note is
// about those lines. Two words, each checked against a fact the surface records rather than read
// as a description: a namespace, and what the old types marked deprecated.
//
// The tie only ever lands on a removal the project is known to use, which already blocks the
// update, so it moves a note next to the lines it explains and never changes a verdict.

const NAMESPACE = /(?<![\w$])namespaces?(?![\w$])/i
const DEPRECATED = /(?<![\w$])deprecated(?![\w$])/i

export function tieRemovals(
  match: MatchResult,
  touched: Touched[],
  surfaces: { from: Surface; to: Surface }
): MatchResult {
  const removed = touched.filter(
    (t) => t.bucket === "removed" && t.strength === "strong"
  )
  if (removed.length === 0 || match.unattributedBreaking.length === 0)
    return match

  const matched: NoteMatch[] = [...match.matched]
  const unattributedBreaking: NoteEntry[] = []
  for (const e of match.unattributedBreaking) {
    const fits = describedRemovals(e, removed, surfaces)
    if (fits.length === 0) {
      unattributedBreaking.push(e)
      continue
    }
    const names = new Map<string, CanonPath>()
    for (const t of fits) {
      const name = lastName(t.change.path)
      if (!names.has(name)) names.set(name, t.change.path)
    }
    // named by the types, not by the note: never direct
    matched.push({
      entry: e,
      hits: [...names].map(([name, subject]) => ({
        name,
        strength: "weak" as const,
        region: "prose" as const,
        subject,
      })),
      direct: false,
    })
  }
  if (unattributedBreaking.length === match.unattributedBreaking.length)
    return match
  // the order the join gives: breaking first, then exact
  matched.sort(
    (a, b) =>
      Number(b.entry.breakingMarker) - Number(a.entry.breakingMarker) ||
      Number(b.direct) - Number(a.direct)
  )
  return { ...match, matched, unattributedBreaking }
}

// A note that names a namespace is about the namespace, even when it also calls it deprecated:
// the namespace's word is the narrower one, and a deprecated class elsewhere is another note's.
function describedRemovals(
  e: NoteEntry,
  removed: Touched[],
  surfaces: { from: Surface; to: Surface }
): Touched[] {
  const words = e.regions
    .filter((r) => r.kind !== "code-block")
    .map((r) => r.text)
    .join("\n")
  if (NAMESPACE.test(words))
    return removed.filter((t) =>
      pathsOf(t).some((p) => leftWithNamespace(p, surfaces))
    )
  if (DEPRECATED.test(words))
    return removed.filter((t) =>
      pathsOf(t).some((p) => wasDeprecated(p, surfaces.from))
    )
  return []
}

function pathsOf(t: Touched): CanonPath[] {
  return [t.change.path, ...t.change.alsoAt]
}

// Gone with a namespace: a namespace itself, or a name of an entry whose `export =` was a namespace
// and no longer is. `export =` of a function or a class records a symbol at the entry's root; a
// namespace records only its members.
function leftWithNamespace(
  path: CanonPath,
  { from, to }: { from: Surface; to: Surface }
): boolean {
  if (from.symbols[path]?.kind === "namespace") return true
  const { prefix } = parsePath(path)
  const subpath = Object.keys(from.entries).find(
    (s) => entryPrefix(from.pkg, s) === prefix
  )
  if (subpath === undefined) return false
  const root = formatPath(from.pkg, subpath, [])
  return (
    !!from.entries[subpath]?.exportEquals &&
    !from.symbols[root] &&
    !to.entries[subpath]?.exportEquals
  )
}

// Marked deprecated in the old types, or inside something that was: a deprecated class takes its
// members with it.
function wasDeprecated(path: CanonPath, from: Surface): boolean {
  const { prefix, segs } = parsePath(path)
  for (let i = segs.length; i > 0; i--) {
    let sym = from.symbols[formatPath(prefix, ".", segs.slice(0, i))]
    for (let hop = 0; hop < 5 && sym?.aliasOf && !sym.deprecated; hop++)
      sym = from.symbols[sym.aliasOf]
    if (sym?.deprecated) return true
  }
  return false
}
