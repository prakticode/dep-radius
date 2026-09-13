import { parsePath } from "../symbol-path.ts"
import type {
  CanonPath,
  Surface,
  SurfaceChange,
  SurfaceDelta,
  SurfaceSymbol,
} from "../model.ts"

// A pure function of two surfaces: identical for everyone who compares these two versions.
export function diffSurfaces(a: Surface, b: Surface): SurfaceDelta {
  const raw: Record<keyof SurfaceDelta, SurfaceChange[]> = {
    removed: [],
    changed: [],
    deprecated: [],
    widened: [],
    added: [],
  }
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

  for (const [path, before] of Object.entries(a.symbols)) {
    const after = b.symbols[path]
    if (!after) {
      raw.removed.push({
        path,
        kind: before.kind,
        before: sigOf(a, before),
        alsoAt: [],
      })
      continue
    }
    if (before.kind === "namespace" && after.kind === "namespace") continue
    const sa = sigOf(a, before)
    const sb = sigOf(b, after)
    if (!sameMultiset(sa, sb) && !(lenient && sameModuloAny(sa, sb))) {
      raw[isWidening(sa, sb) ? "widened" : "changed"].push({
        path,
        kind: after.kind,
        before: sa,
        after: sb,
        alsoAt: [],
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
    changed: collapse(raw.changed),
    deprecated: collapse(raw.deprecated),
    widened: collapse(raw.widened),
    added: collapse(dropChildrenOfRemoved(raw.added)),
  }
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

function parentOf(path: CanonPath): CanonPath | undefined {
  const { prefix, segs } = parsePath(path)
  if (segs.length <= 1) return undefined
  let out = `${prefix}:${segs[0]!.name}`
  for (const s of segs.slice(1, -1)) out += `${s.sep}${s.name}`
  return out
}

// A removed class takes its members with it: report the class.
function dropChildrenOfRemoved(changes: SurfaceChange[]): SurfaceChange[] {
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
