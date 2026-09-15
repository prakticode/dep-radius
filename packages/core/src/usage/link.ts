import { level0Names } from "../symbol-path.ts"
import type { FileFacts, ImportBinding, Pos } from "./parse.ts"
import type { LocalResolver, Target } from "./resolve-local.ts"
import type {
  Binding,
  BlindSpotKind,
  ChainSeg,
  Counted,
  GlobalBlindSpotKind,
  Inventory,
  OpaqueKind,
  PackageUsage,
  RawRef,
  RefOrigin,
  Site,
  UsageMap,
} from "../model.ts"

type PkgTarget = Extract<Target, { kind: "pkg" }>

// What an exported name of a local file turns out to be.
type Origin =
  | { kind: "pkg"; target: PkgTarget; binding: Binding; via: string[] }
  | { kind: "file-namespace"; rel: string; via: string[] }
  | {
      kind: "derived"
      target: PkgTarget
      hops: number
      via: string[]
      origin?: RefOrigin
    }
  | { kind: "local" }

const MAX_DERIVED_HOPS = 3
const MAX_DEPTH = 12

export interface LinkInput {
  root: string
  facts: Map<string, FileFacts>
  resolver: LocalResolver
  inventory: Inventory
  globalSkipped: Site[]
}

interface Acc {
  refs: RawRef[]
  blind: Map<BlindSpotKind, Site[]>
  opaque: Map<OpaqueKind, Site[]>
  proxied: boolean
}

export async function link(
  input: LinkInput
): Promise<UsageMap & { acc: Map<string, Acc> }> {
  const { facts } = input
  const acc = new Map<string, Acc>()
  const accFor = (t: { installedId: string; pkg: string }): Acc => {
    let a = acc.get(t.installedId)
    if (!a) {
      a = { refs: [], blind: new Map(), opaque: new Map(), proxied: false }
      acc.set(t.installedId, a)
    }
    names.set(t.installedId, t.pkg)
    return a
  }
  const names = new Map<string, string>()
  const note = <K>(m: Map<K, Site[]>, k: K, s: Site) => {
    const list = m.get(k) ?? []
    list.push(s)
    m.set(k, list)
  }

  // ---------------------------------------------------------------- resolution, memoized per file
  const resolved = new Map<string, Map<string, Target>>()
  const resolveIn = async (rel: string, spec: string): Promise<Target> => {
    let m = resolved.get(rel)
    if (!m) {
      m = new Map()
      resolved.set(rel, m)
    }
    let t = m.get(spec)
    if (!t) {
      t = await input.resolver.resolve(rel, spec)
      m.set(spec, t)
    }
    return t
  }
  // pre-resolve every specifier so the synchronous walks below never wait
  for (const [rel, f] of facts) {
    const specs = new Set<string>([
      ...f.imports.map((i) => i.specifier),
      ...f.reExports.map((r) => r.specifier),
      ...f.inline.map((i) => i.specifier),
      ...f.sideEffects.map((s) => s.specifier),
    ])
    for (const s of specs) await resolveIn(rel, s)
  }
  const target = (rel: string, spec: string): Target =>
    resolved.get(rel)?.get(spec) ?? { kind: "unknown" }

  const site = (
    rel: string,
    p: Pos,
    typeOnly = false,
    via?: string[]
  ): Site => ({
    file: rel,
    line: p.line,
    col: p.col,
    typeOnly,
    text: p.text,
    ...(via && via.length > 0 ? { via } : {}),
  })

  // ---------------------------------------------------------------- export origins
  const originMemo = new Map<string, Origin[]>()
  const exportOrigin = (
    rel: string,
    name: string,
    depth = 0,
    seen = new Set<string>()
  ): Origin[] => {
    const key = `${rel}\0${name}`
    const memo = originMemo.get(key)
    if (memo) return memo
    if (depth > MAX_DEPTH || seen.has(key)) return []
    seen.add(key)
    const f = facts.get(rel)
    if (!f) return []
    const out: Origin[] = []
    const viaHere = (o: Origin): Origin =>
      o.kind === "local"
        ? o
        : { ...o, via: o.via.includes(rel) ? o.via : [rel, ...o.via] }

    const fromBinding = (b: ImportBinding): Origin[] => {
      const t = target(rel, b.specifier)
      if (t.kind === "pkg")
        return [{ kind: "pkg", target: t, binding: b.binding, via: [rel] }]
      if (t.kind === "file") {
        if (b.binding.kind === "named")
          return exportOrigin(t.rel, b.binding.imported, depth + 1, seen).map(
            viaHere
          )
        if (b.binding.kind === "default")
          return exportOrigin(t.rel, "default", depth + 1, seen).map(viaHere)
        return [{ kind: "file-namespace", rel: t.rel, via: [rel] }]
      }
      return []
    }

    const derivedOrigin = (local: string): Origin[] => {
      const derived = derivedSources(rel).get(local)
      if (!derived) return []
      return derived.map((d) => ({
        kind: "derived" as const,
        target: d.target,
        hops: d.hops + 1,
        via: [rel],
        ...(d.origin ? { origin: d.origin } : {}),
      }))
    }

    for (const el of f.exportedLocals) {
      if (el.exported !== name) continue
      const b = f.imports.find((i) => i.local === el.local)
      if (b) out.push(...fromBinding(b))
      else {
        const d = derivedOrigin(el.local)
        out.push(...(d.length > 0 ? d : [{ kind: "local" as const }]))
      }
    }
    if (out.length === 0 && f.declaredExports.includes(name)) {
      const d = derivedOrigin(name)
      out.push(...(d.length > 0 ? d : [{ kind: "local" as const }]))
    }
    if (out.length === 0) {
      for (const r of f.reExports) {
        const t = target(rel, r.specifier)
        if (r.kind === "named" || r.kind === "star-as") {
          const hit = r.names.find((n) => n.exported === name)
          if (!hit) continue
          if (t.kind === "pkg") {
            const binding: Binding =
              hit.imported === "*"
                ? { kind: "namespace" }
                : hit.imported === "default"
                  ? { kind: "default" }
                  : { kind: "named", imported: hit.imported }
            out.push({ kind: "pkg", target: t, binding, via: [rel] })
          } else if (t.kind === "file") {
            if (hit.imported === "*")
              out.push({ kind: "file-namespace", rel: t.rel, via: [rel] })
            else
              out.push(
                ...exportOrigin(t.rel, hit.imported, depth + 1, seen).map(
                  viaHere
                )
              )
          }
        }
      }
    }
    if (out.length === 0 && name !== "default") {
      // export * never forwards default; local files first, a package only for what they lack
      const stars = f.reExports.filter((r) => r.kind === "star")
      for (const r of stars) {
        const t = target(rel, r.specifier)
        if (t.kind === "file")
          out.push(...exportOrigin(t.rel, name, depth + 1, seen).map(viaHere))
      }
      if (out.length === 0) {
        for (const r of stars) {
          const t = target(rel, r.specifier)
          if (t.kind === "pkg")
            out.push({
              kind: "pkg",
              target: t,
              binding: { kind: "named", imported: name },
              via: [rel],
            })
        }
      }
    }
    seen.delete(key)
    if (depth === 0) originMemo.set(key, out)
    return out
  }

  // Packages a local file forwards wholesale or by name: what makes it a proxy.
  const forwardMemo = new Map<string, Map<string, PkgTarget>>()
  const forwardedPkgs = (
    rel: string,
    seen = new Set<string>()
  ): Map<string, PkgTarget> => {
    const memo = forwardMemo.get(rel)
    if (memo) return memo
    const out = new Map<string, PkgTarget>()
    if (seen.has(rel)) return out
    seen.add(rel)
    const f = facts.get(rel)
    if (f) {
      for (const r of f.reExports) {
        const t = target(rel, r.specifier)
        if (t.kind === "pkg") out.set(t.installedId, t)
        else if (t.kind === "file")
          for (const [k, v] of forwardedPkgs(t.rel, seen)) out.set(k, v)
      }
      for (const el of f.exportedLocals) {
        const b = f.imports.find((i) => i.local === el.local)
        if (!b) continue
        const t = target(rel, b.specifier)
        if (t.kind === "pkg") out.set(t.installedId, t)
        else if (t.kind === "file")
          for (const [k, v] of forwardedPkgs(t.rel, seen)) out.set(k, v)
      }
    }
    forwardMemo.set(rel, out)
    return out
  }

  // ---------------------------------------------------------------- derived values per file
  interface DerivedSource {
    target: PkgTarget
    hops: number
    origin?: RefOrigin
  }
  const derivedMemo = new Map<string, Map<string, DerivedSource[]>>()
  const derivedInProgress = new Set<string>()
  const derivedSources = (rel: string): Map<string, DerivedSource[]> => {
    const memo = derivedMemo.get(rel)
    if (memo) return memo
    const out = new Map<string, DerivedSource[]>()
    if (derivedInProgress.has(rel)) return out
    derivedInProgress.add(rel)
    const f = facts.get(rel)
    if (f) {
      const push = (name: string, src: DerivedSource) => {
        const list = out.get(name) ?? []
        if (!list.some((x) => x.target.installedId === src.target.installedId))
          list.push(src)
        out.set(name, list)
      }
      for (const r of f.references) {
        if (!r.derivedInto) continue
        const b = f.imports.find((i) => i.local === r.local)
        if (b)
          for (const t of pkgTargetsOfBinding(rel, b, r.chain, r.callSelf))
            push(r.derivedInto, t)
      }
      // callback parameters: what a package hands to your function is a value of that package,
      // of a type the scan cannot name, so only its member names are known
      const callbackSources = () => {
        for (const r of f.references) {
          if (!r.callbackInto) continue
          const b = f.imports.find((i) => i.local === r.local)
          const sources = b
            ? pkgTargetsOfBinding(rel, b, r.chain, r.callSelf)
            : (out.get(r.local) ?? [])
          for (const src of sources)
            for (const cb of r.callbackInto)
              push(cb, { target: src.target, hops: src.hops })
        }
        for (const u of f.inline) {
          if (!u.callbackInto) continue
          const t = target(rel, u.specifier)
          if (t.kind === "pkg")
            for (const cb of u.callbackInto) push(cb, { target: t, hops: 0 })
        }
      }
      callbackSources()
      for (const u of f.inline) {
        if (!u.derivedInto) continue
        const t = target(rel, u.specifier)
        if (t.kind === "pkg" && u.binding.kind !== "derived") {
          push(u.derivedInto, {
            target: t,
            hops: 0,
            origin: {
              binding: u.binding,
              entry: t.entry,
              chain: u.chain,
              callSelf: u.callSelf,
            },
          })
        }
      }
      // chains of derived values inside the file: const app = createApp(); const r = app.route()
      for (let round = 0; round < 3; round++) {
        for (const r of f.references) {
          if (!r.derivedInto || f.imports.some((i) => i.local === r.local))
            continue
          for (const src of out.get(r.local) ?? []) {
            push(r.derivedInto, {
              ...src,
              ...(src.origin
                ? { origin: extendOrigin(src.origin, r.chain, r.callSelf) }
                : {}),
            })
          }
        }
        callbackSources()
      }
    }
    derivedInProgress.delete(rel)
    derivedMemo.set(rel, out)
    return out
  }

  // The packages a binding's value comes from, following local files.
  const pkgTargetsOfBinding = (
    rel: string,
    b: ImportBinding,
    chain: ChainSeg[],
    callSelf: boolean
  ): DerivedSource[] => {
    const t = target(rel, b.specifier)
    const direct = b.binding.kind === "derived" ? undefined : b.binding
    if (t.kind === "pkg")
      return direct
        ? [
            {
              target: t,
              hops: 0,
              origin: { binding: direct, entry: t.entry, chain, callSelf },
            },
          ]
        : []
    if (t.kind !== "file") return []
    let origins: Origin[]
    let rest = chain
    let restCall = callSelf
    if (b.binding.kind === "named")
      origins = exportOrigin(t.rel, b.binding.imported)
    else if (b.binding.kind === "default")
      origins = exportOrigin(t.rel, "default")
    else {
      // `import * as v from "./schema"; const s = v.object()`: the head names the export
      const head = chain[0]
      origins = head ? exportOrigin(t.rel, head.name) : []
      rest = chain.slice(1)
      restCall = !!head?.call
    }
    const out: DerivedSource[] = []
    for (const o of origins) {
      if (o.kind === "pkg" && o.binding.kind !== "derived") {
        out.push({
          target: o.target,
          hops: 0,
          origin: {
            binding: o.binding,
            entry: o.target.entry,
            chain: rest,
            callSelf: restCall,
          },
        })
      } else if (o.kind === "derived") {
        out.push({
          target: o.target,
          hops: o.hops,
          ...(o.origin
            ? { origin: extendOrigin(o.origin, rest, restCall) }
            : {}),
        })
      }
    }
    return out
  }

  // ---------------------------------------------------------------- attribution
  const emitThrough = (
    rel: string,
    origins: Origin[],
    chain: ChainSeg[],
    callSelf: boolean,
    s: Site,
    specifier: string,
    escape: boolean,
    computed: boolean,
    depth = 0
  ) => {
    for (const o of origins) {
      if (o.kind === "local") continue
      if (o.kind === "pkg") {
        const a = accFor(o.target)
        a.proxied = true
        const viaSite = { ...s, via: o.via }
        if (escape && o.binding.kind !== "named")
          note(a.blind, "namespace-escape", viaSite)
        else if (computed && chain.length === 0)
          note(a.blind, "computed-member", viaSite)
        else
          a.refs.push(
            rawRef(o.target, specifier, o.binding, chain, callSelf, viaSite)
          )
      } else if (o.kind === "derived") {
        const a = accFor(o.target)
        const viaSite = { ...s, via: o.via }
        if (o.hops > MAX_DERIVED_HOPS) note(a.blind, "derived-escape", viaSite)
        else if (chain.length > 0)
          a.refs.push(
            rawRef(
              o.target,
              specifier,
              { kind: "derived" },
              chain,
              callSelf,
              viaSite,
              o.origin
            )
          )
      } else if (o.kind === "file-namespace") {
        if (depth > MAX_DEPTH) continue
        const [head, ...rest] = chain
        if (!head) {
          if (escape)
            for (const t of forwardedPkgs(o.rel).values())
              note(accFor(t).blind, "namespace-escape", { ...s, via: o.via })
          continue
        }
        const next = exportOrigin(o.rel, head.name).map((x) =>
          x.kind === "local"
            ? x
            : {
                ...x,
                via: [...o.via, ...x.via.filter((v) => !o.via.includes(v))],
              }
        )
        // `ns.email()` through a namespace of a proxy: the head becomes the named import
        const adjusted = next.map((x) =>
          x.kind === "pkg" && x.binding.kind === "named"
            ? {
                ...x,
                binding: {
                  kind: "named" as const,
                  imported: x.binding.imported,
                },
              }
            : x
        )
        emitThrough(
          rel,
          adjusted,
          rest,
          head.call,
          s,
          specifier,
          false,
          computed,
          depth + 1
        )
      }
    }
  }

  const globalCounts = new Map<GlobalBlindSpotKind, Site[]>()
  const unresolvedLocal: Site[] = []

  for (const [rel, f] of facts) {
    if (f.unparseable)
      note(
        globalCounts,
        "unparseable-file",
        site(rel, { line: 1, col: 1, text: "" })
      )
    for (const p of f.nonLiteralRequire)
      note(globalCounts, "require-nonliteral", site(rel, p))
    for (const p of f.nonLiteralImport)
      note(globalCounts, "dynamic-import-nonliteral", site(rel, p))

    const bindingByLocal = new Map(f.imports.map((i) => [i.local, i]))
    for (const b of f.imports) {
      const t = target(rel, b.specifier)
      if (t.kind === "unresolved-local") unresolvedLocal.push(site(rel, b.pos))
    }

    for (const r of f.references) {
      const s = site(rel, r.pos, r.typeOnly)
      const b = bindingByLocal.get(r.local)
      if (b) {
        const t = target(rel, b.specifier)
        if (t.kind === "pkg") {
          const a = accFor(t)
          if (r.escape) note(a.blind, "namespace-escape", s)
          else if (r.computed && r.chain.length === 0)
            note(a.blind, "computed-member", s)
          else
            a.refs.push(
              rawRef(t, b.specifier, b.binding, r.chain, r.callSelf, s)
            )
          if (r.computed && r.chain.length > 0)
            note(a.blind, "computed-member", s)
        } else if (t.kind === "file") {
          let origins: Origin[]
          if (b.binding.kind === "named")
            origins = exportOrigin(t.rel, b.binding.imported)
          else if (b.binding.kind === "default")
            origins = exportOrigin(t.rel, "default")
          else origins = [{ kind: "file-namespace", rel: t.rel, via: [] }]
          emitThrough(
            rel,
            origins,
            r.chain,
            r.callSelf,
            s,
            b.specifier,
            r.escape,
            r.computed
          )
        }
        continue
      }
      // a reference on a derived value of this file
      for (const src of derivedSources(rel).get(r.local) ?? []) {
        const a = accFor(src.target)
        if (src.hops > MAX_DERIVED_HOPS) note(a.blind, "derived-escape", s)
        else if (r.chain.length > 0)
          a.refs.push(
            rawRef(
              src.target,
              src.target.pkg,
              { kind: "derived" },
              r.chain,
              r.callSelf,
              s,
              src.origin
            )
          )
      }
    }

    for (const u of f.inline) {
      const t = target(rel, u.specifier)
      const s = site(rel, u.pos)
      if (t.kind === "pkg") {
        const a = accFor(t)
        if (u.escape)
          note(
            a.blind,
            u.binding.kind === "namespace"
              ? "dynamic-import-escape"
              : "namespace-escape",
            s
          )
        else
          a.refs.push(rawRef(t, u.specifier, u.binding, u.chain, u.callSelf, s))
      } else if (t.kind === "file" && !u.escape) {
        emitThrough(
          rel,
          [{ kind: "file-namespace", rel: t.rel, via: [] }],
          u.chain,
          u.callSelf,
          s,
          u.specifier,
          false,
          false
        )
      }
    }

    for (const se of f.sideEffects) {
      const t = target(rel, se.specifier)
      if (t.kind === "pkg")
        note(accFor(t).opaque, "side-effect-import", site(rel, se.pos))
    }

    for (const p of f.prefixImports) {
      const t = await resolveIn(rel, p.prefix.replace(/\/$/, ""))
      if (t.kind === "pkg")
        note(accFor(t).blind, "prefix-dynamic-import", site(rel, p.pos))
    }

    // a file that forwards a package: mark it so unresolved local imports count against that package
    for (const t of forwardedPkgs(rel).values()) accFor(t).proxied = true
  }

  // public entry points of publishable manifests that forward a package
  for (const m of input.inventory.manifests) {
    if (m.private) continue
    const dirRel = relOf(input.root, m.dir)
    const base = dirRel === "." ? "" : `${dirRel}/`
    const entries = new Set<string>()
    for (const e of [m.main, m.module, m.types]) if (e) entries.add(e)
    collectExportTargets(m.exports, entries)
    for (const e of entries) {
      const hit = input.resolver.tryFile(base + e.replace(/^\.\//, ""))
      if (!hit || !facts.has(hit)) continue
      for (const t of forwardedPkgs(hit).values())
        note(
          accFor(t).blind,
          "public-reexport",
          site(hit, { line: 1, col: 1, text: "" })
        )
    }
  }

  // every file was scanned, so the proxies are all known; what stays unknown is who reached them
  // through an import that did not resolve
  for (const a of acc.values()) {
    if (a.proxied && unresolvedLocal.length > 0)
      a.blind.set("unresolved-local-import", unresolvedLocal)
  }
  for (const s of input.globalSkipped)
    note(globalCounts, "skipped-generated", s)

  // each key where it is written: a call spread over lines also lands on the line of the option
  const passedAt = new Map<string, Record<string, Site>>()
  for (const [rel, f] of facts)
    for (const p of f.passedKeys ?? [])
      passedAt.set(
        `${rel}:${p.line}:${p.col}`,
        Object.fromEntries(p.keys.map((key, i) => [key, site(rel, p.at[i]!)]))
      )

  const packages: Record<string, PackageUsage> = {}
  for (const [id, a] of acc) {
    const passed = new Map<string, Site[]>()
    for (const r of a.refs) {
      const keys = passedAt.get(`${r.site.file}:${r.site.line}:${r.site.col}`)
      if (!keys) continue
      r.passed = Object.fromEntries(
        Object.entries(keys).map(([key, at]) => [
          key,
          r.site.via ? { ...at, via: r.site.via } : at,
        ])
      )
      for (const [key, at] of Object.entries(r.passed)) {
        note(passed, key, r.site)
        note(passed, key, at)
      }
    }
    const strong = new Set<string>()
    const weak = new Set<string>()
    for (const r of a.refs) {
      const n = level0Names(r)
      for (const x of n.strong) strong.add(x)
      for (const x of n.weak) weak.add(x)
    }
    for (const x of strong) weak.delete(x)
    packages[id] = {
      installedId: id,
      pkg: names.get(id) ?? id,
      refs: a.refs,
      strongNames: [...strong].sort(),
      weakNames: [...weak].sort(),
      files: new Set(a.refs.map((r) => r.site.file)).size,
      opaque: counted(a.opaque),
      blindSpots: counted(a.blind),
      ...(passed.size > 0 ? { passedOptions: Object.fromEntries(passed) } : {}),
    }
  }
  return {
    scannedFiles: facts.size,
    packages,
    global: counted(globalCounts),
    acc,
  }
}

function rawRef(
  t: PkgTarget,
  specifier: string,
  binding: Binding,
  chain: ChainSeg[],
  callSelf: boolean,
  site: Site,
  origin?: RefOrigin
): RawRef {
  return {
    installedId: t.installedId,
    pkg: t.pkg,
    specifier,
    entry: origin?.entry ?? t.entry,
    binding,
    chain,
    callSelf,
    site,
    ...(origin ? { origin } : {}),
  }
}

// The value built by `origin`, then read further: `schema` then `schema.safeParse()`.
export function extendOrigin(
  origin: RefOrigin,
  chain: ChainSeg[],
  callSelf: boolean
): RefOrigin {
  const base = origin.chain.map((s) => ({ ...s }))
  let self = origin.callSelf
  if (callSelf) {
    const last = base[base.length - 1]
    if (last) last.call = true
    else self = true
  }
  return { ...origin, chain: [...base, ...chain], callSelf: self }
}

export function counted<K extends string>(m: Map<K, Site[]>): Counted<K>[] {
  return [...m.entries()]
    .filter(([, sites]) => sites.length > 0)
    .map(([kind, sites]) => ({
      kind,
      count: sites.length,
      examples: sites.slice(0, 3),
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

function collectExportTargets(exp: unknown, out: Set<string>): void {
  if (typeof exp === "string") out.add(exp)
  else if (Array.isArray(exp)) for (const x of exp) collectExportTargets(x, out)
  else if (exp && typeof exp === "object")
    for (const v of Object.values(exp)) collectExportTargets(v, out)
}

function relOf(root: string, abs: string): string {
  const r = abs.startsWith(root)
    ? abs.slice(root.length).replace(/^\/+/, "")
    : abs
  return r || "."
}
