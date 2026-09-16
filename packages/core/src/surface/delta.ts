import { entryPrefix, parsePath } from "../symbol-path.ts"
import { matching, splitSeparators } from "./signature.ts"
import type {
  CanonPath,
  Surface,
  SurfaceChange,
  SurfaceDelta,
  SurfaceSymbol,
  UnprovenCause,
  UnprovenRemoval,
} from "../model.ts"

// Bump when the diff changes: the delta cache key carries it.
export const DELTA_VERSION = 1

// A pure function of two surfaces: identical for everyone who compares these two versions.
export function diffSurfaces(a: Surface, b: Surface): SurfaceDelta {
  const raw: Record<
    Exclude<keyof SurfaceDelta, "unproven">,
    SurfaceChange[]
  > = {
    removed: [],
    changed: [],
    deprecated: [],
    widened: [],
    added: [],
  }
  const unproven: UnprovenRemoval[] = []
  // a type from a dependency the virtual host cannot load prints as `any` on one side and by name
  // on the other when a declaration merely adds an annotation: not a change anyone can act on
  const lenient =
    a.flags.includes("external-types-unresolved") ||
    b.flags.includes("external-types-unresolved")
  const sigOf = (s: Surface, sym: SurfaceSymbol): string[] => {
    let cur = sym
    for (let i = 0; i < 5 && cur.aliasOf; i++) {
      const next = s.symbols[cur.aliasOf]
      if (!next) break
      cur = next
    }
    return cur.sig
  }

  const aliasesInA = new Map<CanonPath, CanonPath[]>()
  for (const [path, sym] of Object.entries(a.symbols))
    if (sym.aliasOf)
      aliasesInA.set(sym.aliasOf, [
        ...(aliasesInA.get(sym.aliasOf) ?? []),
        path,
      ])

  for (const [path, before] of Object.entries(a.symbols)) {
    const after = findMoved(b, path, aliasesInA)
    if (!after) {
      const change = {
        path,
        kind: before.kind,
        before: sigOf(a, before),
        alsoAt: [],
      }
      const cause = unprovenCause(b, path)
      if (cause) unproven.push({ ...change, cause })
      else raw.removed.push(change)
      continue
    }
    if (before.kind === "namespace" && after.kind === "namespace") continue
    const sa = sigOf(a, before)
    const sb = sigOf(b, after)
    if (!sameMultiset(sa, sb) && !(lenient && sameModuloAny(sa, sb))) {
      // a namespace or a call-less interface that gains signatures breaks no use of its members
      const gainsSignatures =
        sa.length === 0 &&
        (before.kind === "namespace" || before.kind === "interface")
      const widened = gainsSignatures || isWidening(sa, sb)
      const fromParam = widened ? undefined : firstChangedParam(sa, sb)
      raw[widened ? "widened" : "changed"].push({
        path,
        kind: after.kind,
        before: sa,
        after: sb,
        alsoAt: [],
        ...(fromParam !== undefined ? { fromParam } : {}),
      })
    } else if (!before.deprecated && after.deprecated && !before.aliasOf) {
      raw.deprecated.push({
        path,
        kind: after.kind,
        before: sa,
        after: sb,
        alsoAt: [],
      })
    }
  }
  for (const [path, after] of Object.entries(b.symbols)) {
    if (!a.symbols[path])
      raw.added.push({
        path,
        kind: after.kind,
        after: sigOf(b, after),
        alsoAt: [],
      })
  }

  return {
    removed: collapse(dropChildrenOfRemoved(raw.removed)),
    unproven: dropChildrenOfRemoved(unproven),
    changed: collapse(raw.changed),
    deprecated: collapse(raw.deprecated),
    widened: collapse(raw.widened),
    added: collapse(dropChildrenOfRemoved(raw.added)),
  }
}

// The same symbol under another name: `export { z }` and `export default z` walk as `lib:default`,
// with `lib:z` an alias of it, so `lib:z.object` lives at `lib:default.object`.
function resolveIn(
  s: Surface,
  path: CanonPath,
  depth = 0
): SurfaceSymbol | undefined {
  const direct = s.symbols[path]
  if (direct || depth > 4) return direct
  for (const prefix of ancestors(path)) {
    const target = s.symbols[prefix]?.aliasOf
    if (target)
      return resolveIn(s, target + path.slice(prefix.length), depth + 1)
  }
  return undefined
}

// A path gone from the new surface that the old surface also reached under another name, still
// present: `ws:default.WebSocketServer` was also `ws:WebSocketServer`, which remains.
function findMoved(
  b: Surface,
  path: CanonPath,
  aliasesInA: Map<CanonPath, CanonPath[]>
): SurfaceSymbol | undefined {
  const found = resolveIn(b, path)
  if (found) return found
  for (const prefix of [path, ...ancestors(path)]) {
    for (const alias of aliasesInA.get(prefix) ?? []) {
      const moved = resolveIn(b, alias + path.slice(prefix.length))
      if (moved) return moved
    }
  }
  return undefined
}

// Longest first: `lib:a.b#c` gives `lib:a.b`, then `lib:a`.
function ancestors(path: CanonPath): CanonPath[] {
  const out: CanonPath[] = []
  for (let p = parentOf(path); p; p = parentOf(p)) out.push(p)
  return out
}

function unprovenCause(b: Surface, path: CanonPath): UnprovenCause | undefined {
  const { prefix } = parsePath(path)
  const entry = Object.entries(b.entries).find(
    ([subpath]) => entryPrefix(b.pkg, subpath) === prefix
  )?.[1]
  // a member of a class still there is explained by its base before anything about the entry
  if (ancestors(path).some((p) => resolveIn(b, p)?.unresolvedBase))
    return "unresolved-base"
  if (entry?.externalReexports?.length) return "external-reexport"
  if (b.flags.includes("symbol-cap")) return "symbol-cap"
  if (!entry && b.flags.includes("wildcard-truncated")) return "subpath-cap"
  return undefined
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((v, i) => v === y[i])
}

export function sameModuloAny(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((s, i) => anyMatches(s, y[i]!) || anyMatches(y[i]!, s))
}

function anyMatches(withAny: string, other: string): boolean {
  if (!/(?<![\w$])any(?![\w$])/.test(withAny)) return false
  const pattern = withAny
    .split(/(?<![\w$])any(?![\w$])/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\w$.<>\\[\\], |&]+?")
  return new RegExp(`^${pattern}$`).test(other)
}

// Adding an overload, or appending optional parameters, breaks no existing call.
function isWidening(before: string[], after: string[]): boolean {
  if (before.length === 0) return false
  const afterSet = new Set(after)
  if (before.every((s) => afterSet.has(s))) return true
  return before.every((old) => after.some((neu) => appendsOptional(old, neu)))
}

function appendsOptional(old: string, neu: string): boolean {
  const po = /^(<[^>]*>)?\((.*)\) => (.*)$/.exec(old)
  const pn = /^(<[^>]*>)?\((.*)\) => (.*)$/.exec(neu)
  if (!po || !pn) return false
  if ((po[1] ?? "") !== (pn[1] ?? "") || po[3] !== pn[3]) return false
  const a = po[2] ?? ""
  const b = pn[2] ?? ""
  if (!b.startsWith(a)) return false
  const extra = b.slice(a.length).replace(/^,\s*/, "")
  return (
    extra.length > 0 &&
    extra.split(/,\s*/).every((p) => p.endsWith("?") || p.startsWith("..."))
  )
}

// Overloads compared in order: each keeps its type parameters, its return type and its arity, and
// every parameter from the first that differs on is optional on both sides. A call with no more
// arguments than that index resolves the same overload to the same type, whatever the library.
function firstChangedParam(
  before: string[],
  after: string[]
): number | undefined {
  if (before.length === 0 || before.length !== after.length) return undefined
  let first: number | undefined
  for (const [i, text] of before.entries()) {
    const a = parseSignature(text)
    const b = parseSignature(after[i]!)
    if (
      !a ||
      !b ||
      a.typeParams !== b.typeParams ||
      a.returns !== b.returns ||
      a.params.length !== b.params.length
    )
      return undefined
    const k = a.params.findIndex((p, j) => p !== b.params[j])
    if (k < 0) continue
    const optional = (p: string) => p.endsWith("?") || p.startsWith("...")
    if (
      !a.params.slice(k).every(optional) ||
      !b.params.slice(k).every(optional)
    )
      return undefined
    first = Math.min(first ?? k, k)
  }
  return first
}

// "<$T0>(a, b?) => R" as its parts, or undefined for anything else (a hashed or non-call signature)
function parseSignature(
  s: string
): { typeParams: string; params: string[]; returns: string } | undefined {
  let open = 0
  if (s.startsWith("<")) {
    const end = matching(s, 0)
    if (end < 0) return undefined
    open = end + 1
  }
  if (s[open] !== "(") return undefined
  const close = matching(s, open)
  if (close < 0 || !s.startsWith(" => ", close + 1)) return undefined
  const inner = s.slice(open + 1, close)
  return {
    typeParams: s.slice(0, open),
    params:
      inner.trim() === ""
        ? []
        : splitSeparators(inner).map((p) => p.replace(/,\s*$/, "").trim()),
    returns: s.slice(close + 5),
  }
}

function parentOf(path: CanonPath): CanonPath | undefined {
  const { prefix, segs } = parsePath(path)
  if (segs.length <= 1) return undefined
  let out = `${prefix}:${segs[0]!.name}`
  for (const s of segs.slice(1, -1)) out += `${s.sep}${s.name}`
  return out
}

// A removed class takes its members with it: report the class.
function dropChildrenOfRemoved<T extends SurfaceChange>(changes: T[]): T[] {
  const paths = new Set(changes.map((c) => c.path))
  return changes.filter((c) => {
    for (let p = parentOf(c.path); p; p = parentOf(p))
      if (paths.has(p)) return false
    return true
  })
}

// The same change seen through several entries (lib:email, lib/v2:email, lib:ns.email) is one change.
function collapse(changes: SurfaceChange[]): SurfaceChange[] {
  const groups = new Map<string, SurfaceChange[]>()
  for (const c of changes) {
    const segs = parsePath(c.path).segs
    const last = segs[segs.length - 1]
    const key = JSON.stringify([
      c.kind,
      last?.sep,
      last?.name,
      c.before ?? null,
      c.after ?? null,
    ])
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }
  const out: SurfaceChange[] = []
  for (const list of groups.values()) {
    list.sort(
      (x, y) => rank(x.path) - rank(y.path) || x.path.localeCompare(y.path)
    )
    const [head, ...rest] = list
    out.push({ ...head!, alsoAt: rest.map((r) => r.path) })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

function rank(path: CanonPath): number {
  const { prefix, segs } = parsePath(path)
  return prefix.split("/").length * 10 + segs.length
}

export function surfaceChangeCount(d: SurfaceDelta): number {
  return d.removed.length + d.changed.length + d.deprecated.length
}
