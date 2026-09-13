import type {
  CanonPath,
  ChainSeg,
  RawRef,
  Surface,
  SurfaceSymbol,
} from "./model.ts"

// The one place a symbol path is spelled. The usage scan and the surface walk both go through
// these functions, so they cannot disagree on what `lib:email` means.
//
//   <pkg><subpath>:<segments>   "." namespace or static member, "#" instance member
//   lib:email   lib:coerce.number   lib:StringSchema#max   lib/locales:fr

export interface Seg {
  name: string
  sep: "." | "#"
}

export function entryPrefix(pkg: string, entry: string): string {
  return entry === "." ? pkg : `${pkg}${entry.slice(1)}`
}

export function formatPath(pkg: string, entry: string, segs: Seg[]): CanonPath {
  let out = `${entryPrefix(pkg, entry)}:`
  segs.forEach((s, i) => {
    out += i === 0 ? s.name : `${s.sep}${s.name}`
  })
  return out
}

export function parsePath(path: CanonPath): { prefix: string; segs: Seg[] } {
  const colon = path.indexOf(":", path.startsWith("@") ? path.indexOf("/") : 0)
  const prefix = path.slice(0, colon)
  const rest = path.slice(colon + 1)
  const segs: Seg[] = []
  let sep: Seg["sep"] = "."
  let cur = ""
  for (const ch of rest) {
    if (ch === "." || ch === "#") {
      if (cur) segs.push({ name: cur, sep })
      sep = ch
      cur = ""
    } else cur += ch
  }
  if (cur) segs.push({ name: cur, sep })
  return { prefix, segs }
}

export function lastName(path: CanonPath): string {
  const segs = parsePath(path).segs
  return segs[segs.length - 1]?.name ?? ""
}

// A short or default named import that is not itself called is almost always a namespace alias:
// `import { v } from "lib"; v.object()`. Called, it is a function: `import { fr } from "lib/locales"; fr()`.
export function isNamespaceAlias(imported: string, called: boolean): boolean {
  return !called && (imported === "default" || imported.length <= 2)
}

// The chain as seen from the package's entry module, before any surface is known.
export function effectiveChain(ref: RawRef): {
  segs: ChainSeg[]
  startsCalled: boolean
} {
  const b = ref.binding
  let segs: ChainSeg[]
  if (b.kind === "named") {
    segs = isNamespaceAlias(b.imported, ref.callSelf)
      ? [...ref.chain]
      : [{ name: b.imported, call: ref.callSelf }, ...ref.chain]
  } else {
    segs = [...ref.chain]
  }
  segs = segs.filter((s, i) => !(i === 0 && s.name === "default"))
  const startsCalled = b.kind !== "named" && ref.callSelf
  return { segs, startsCalled }
}

export interface Resolution {
  paths: CanonPath[]
  // names left once the walk lost the type: matched against members by name only
  unresolvedTail: string[]
  // the first name the chain reaches for is not in the surface at all
  missingHead: boolean
}

const MAX_HOPS = 6

type Cursor = { kind: "ns"; base: string } | { kind: "type"; path: CanonPath }

// Level 1: walk a usage chain through a surface. `v.email().max(254)` from "lib" resolves to
// lib:email, then through its return type to lib:EmailSchema#max.
export function resolveRef(surface: Surface, ref: RawRef): Resolution {
  // the surface's own name: @types/lib answers for code that imports "lib"
  const prefix = entryPrefix(surface.pkg, ref.entry)
  const out: Resolution = { paths: [], unresolvedTail: [], missingHead: false }
  if (ref.binding.kind === "derived") {
    if (!ref.origin) {
      out.unresolvedTail = ref.chain.map((s) => s.name)
      return out
    }
    // walk the construction, then the reads: only the reads are this site's own paths
    const o = ref.origin
    const base = resolveRef(surface, {
      ...ref,
      binding: o.binding,
      entry: o.entry,
      chain: o.chain,
      callSelf: o.callSelf,
      origin: undefined,
    })
    const full = resolveRef(surface, {
      ...ref,
      binding: o.binding,
      entry: o.entry,
      chain: [
        ...o.chain.map((s, i) =>
          i === o.chain.length - 1 && ref.callSelf ? { ...s, call: true } : s
        ),
        ...ref.chain,
      ],
      callSelf: o.chain.length === 0 ? o.callSelf || ref.callSelf : o.callSelf,
      origin: undefined,
    })
    // the walk is sequential, so the construction's paths are a prefix of the full walk
    const prefixLen = base.paths.every((p, i) => full.paths[i] === p)
      ? base.paths.length
      : 0
    return {
      paths: full.paths.slice(prefixLen),
      unresolvedTail: full.unresolvedTail,
      missingHead: false,
    }
  }
  const entry = surface.entries[ref.entry]
  if (!entry) {
    out.missingHead = true
    out.unresolvedTail = ref.chain.map((s) => s.name)
    return out
  }
  const sym = (p: CanonPath): SurfaceSymbol | undefined => {
    let s = surface.symbols[p]
    for (let i = 0; i < 5 && s?.aliasOf; i++) {
      const next = surface.symbols[s.aliasOf]
      if (!next) break
      s = next
    }
    return s
  }
  const modulePath = `${prefix}:`
  const lookup = (cur: Cursor, name: string): CanonPath =>
    cur.kind === "ns"
      ? cur.base.endsWith(":")
        ? `${cur.base}${name}`
        : `${cur.base}.${name}`
      : `${cur.path}#${name}`

  const b = ref.binding
  let cursor: Cursor | undefined = { kind: "ns", base: modulePath }
  let segs: ChainSeg[]
  let startCall = false
  if (b.kind === "named") {
    if (
      isNamespaceAlias(b.imported, ref.callSelf) &&
      !surface.symbols[`${modulePath}${b.imported}`]
    )
      segs = [...ref.chain]
    else segs = [{ name: b.imported, call: ref.callSelf }, ...ref.chain]
  } else if (b.kind === "default") {
    // ESM default export, else CommonJS interop hands over the module itself
    const d = surface.symbols[`${modulePath}default`]
    if (d) segs = [{ name: "default", call: ref.callSelf }, ...ref.chain]
    else {
      segs = [...ref.chain]
      startCall = ref.callSelf
    }
  } else {
    segs = [...ref.chain]
    startCall = ref.callSelf
  }

  if (startCall) {
    const self = surface.symbols[modulePath]
    if (!self) {
      out.unresolvedTail = segs.map((s) => s.name)
      return out
    }
    out.paths.push(modulePath)
    cursor = self.returns
      ? { kind: "type", path: self.returns }
      : self.instanceOf
        ? { kind: "type", path: self.instanceOf }
        : undefined
  } else if (segs.length === 0) {
    return out
  }

  let hops = 0
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (!cursor || hops++ >= MAX_HOPS) {
      out.unresolvedTail.push(...segs.slice(i).map((s) => s.name))
      break
    }
    const path = lookup(cursor, seg.name)
    const raw = surface.symbols[path]
    const found = sym(path)
    if (!raw || !found) {
      if (i === 0 && !startCall) out.missingHead = true
      out.unresolvedTail.push(...segs.slice(i).map((s) => s.name))
      break
    }
    out.paths.push(path)
    if (raw.aliasOf && found.path !== path) out.paths.push(found.path)
    if (found.kind === "namespace") {
      cursor = { kind: "ns", base: found.path }
      continue
    }
    if (seg.call || seg.construct) {
      const next = seg.construct
        ? (found.instanceOf ?? found.returns)
        : found.returns
      cursor = next ? { kind: "type", path: next } : undefined
      continue
    }
    if (found.kind === "class" || found.kind === "enum")
      cursor = { kind: "ns", base: found.path }
    else if (found.kind === "interface" || found.kind === "type")
      cursor = { kind: "type", path: found.path }
    else if (found.instanceOf) cursor = { kind: "type", path: found.instanceOf }
    else
      cursor =
        found.kind === "variable" ? { kind: "ns", base: found.path } : undefined
  }
  return out
}

// Strong: segments up to and including the first call. Weak: what follows, and everything on a
// derived value or on the result of calling the package itself (`createApp().use`).
export function level0Names(ref: RawRef): { strong: string[]; weak: string[] } {
  if (ref.binding.kind === "derived")
    return { strong: [], weak: ref.chain.map((s) => s.name) }
  const { segs, startsCalled } = effectiveChain(ref)
  const strong: string[] = []
  const weak: string[] = []
  let called = startsCalled
  for (const s of segs) {
    if (called) weak.push(s.name)
    else strong.push(s.name)
    if (s.call) called = true
  }
  return { strong, weak }
}
