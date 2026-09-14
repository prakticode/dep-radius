import { posix } from "node:path"

import type { CanonPath } from "../../model.ts"
import { formatPath } from "../../symbol-path.ts"
import {
  type ExportTarget,
  type ParsedModule,
  type ParsedUnit,
  parseModule,
} from "./parse.ts"
import {
  type Flavor,
  resolveFile,
  resolveRuntimeEntries,
  runtimeForTarget,
} from "./entries.ts"
import {
  IMPLEMENTATION_ALGO,
  type ImplementationFacts,
  type ImplementationFlag,
  type ImplementationResult,
  type ImplementationUnit,
} from "./model.ts"

export interface Limits {
  files: number
  fileBytes: number
  units: number
  // syntax nodes visited across the package, the deterministic stand-in for a time limit
  work: number
  exports: number
  // a member call `x.name()` links to every method of that name, up to this many
  memberCandidates: number
}

export const DEFAULT_LIMITS: Limits = {
  files: 600,
  fileBytes: 2_000_000,
  units: 40_000,
  work: 6_000_000,
  exports: 4_000,
  memberCandidates: 4,
}

const STAR_DEPTH = 8

export function buildImplementationFacts(
  pkg: string,
  version: string,
  integrity: string,
  files: Map<string, Buffer>,
  flavor: Flavor,
  limits: Limits = DEFAULT_LIMITS
): ImplementationResult {
  let pj: Record<string, unknown> = {}
  try {
    const raw = files.get("package.json")
    pj = raw
      ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
      : {}
  } catch {
    return { ok: false, reason: "failed", detail: "unreadable package.json" }
  }
  const names = [...files.keys()]
  const has = (p: string) => files.has(p)
  const { entries, wildcardTruncated } = resolveRuntimeEntries(
    pj,
    names,
    flavor
  )
  if (entries.length === 0) return { ok: false, reason: "no-entry" }

  const flags = new Set<ImplementationFlag>()
  if (wildcardTruncated) flags.add("wildcard-truncated")

  // `#internal` specifiers, from the package's own imports map
  const importsMap =
    pj.imports && typeof pj.imports === "object"
      ? (pj.imports as Record<string, unknown>)
      : {}
  const selfName = typeof pj.name === "string" ? pj.name : pkg

  // undefined: another package, or a file the tarball does not have
  const resolveSpec = (from: string, spec: string): string | undefined => {
    if (spec.startsWith(".") || spec.startsWith("/"))
      return resolveFile(
        posix.normalize(posix.join(posix.dirname(from), spec)),
        has
      )
    if (spec.startsWith("#"))
      return runtimeForTarget(importsMap[spec], has, flavor)
    // the package importing itself by name
    if (spec === selfName || spec.startsWith(`${selfName}/`)) {
      const sub = `.${spec.slice(selfName.length)}`
      return entries.find((e) => e.subpath === sub)?.file
    }
    return undefined
  }

  const modules = new Map<string, ParsedModule>()
  let work = 0
  const queue = entries.map((e) => e.file)
  while (queue.length > 0) {
    const file = queue.shift()!
    if (modules.has(file)) continue
    if (modules.size >= limits.files) {
      flags.add("file-cap")
      break
    }
    const buf = files.get(file)
    if (!buf) continue
    if (buf.length > limits.fileBytes) {
      flags.add("file-too-large")
      continue
    }
    if (work > limits.work) {
      flags.add("work-cap")
      break
    }
    const mod = parseModule(file, buf.toString("utf8"), limits.work - work)
    work += mod.work
    if (work > limits.work) flags.add("work-cap")
    if (mod.minified) flags.add("minified")
    if (mod.unparseable) flags.add("unparseable-file")
    modules.set(file, mod)
    const specs = [
      ...[...mod.imports.values()].map((i) => i.spec),
      ...mod.stars,
      ...[...mod.exports.values(), ...(mod.self ? [mod.self] : [])].flatMap(
        (t) => (t.kind === "import" || t.kind === "namespace" ? [t.spec] : [])
      ),
      ...mod.units.flatMap((u) =>
        u.refs.flatMap((r) => (r.kind === "module" ? [r.spec] : []))
      ),
    ]
    for (const s of [...new Set(specs)].sort()) {
      const target = resolveSpec(file, s)
      if (target && !modules.has(target)) queue.push(target)
    }
  }

  // one global table, files in a stable order
  const units: ImplementationUnit[] = []
  const base = new Map<string, number>()
  for (const file of [...modules.keys()].sort()) {
    const mod = modules.get(file)!
    if (units.length + mod.units.length > limits.units) {
      flags.add("unit-cap")
      break
    }
    base.set(file, units.length)
    for (const u of mod.units)
      units.push({
        name: u.name,
        file,
        kind: u.kind,
        fp: u.fp,
        calls: [],
        members: [],
      })
  }
  const gid = (file: string, local: number) => base.get(file)! + local

  const byMemberName = new Map<string, number[]>()
  for (const [file, mod] of modules) {
    if (!base.has(file)) continue
    mod.units.forEach((u, i) => {
      if (u.kind !== "method") return
      const short = u.name.slice(
        Math.max(
          u.name.lastIndexOf("/"),
          u.name.lastIndexOf("#"),
          u.name.lastIndexOf(".")
        ) + 1
      )
      const list = byMemberName.get(short) ?? []
      list.push(gid(file, i))
      byMemberName.set(short, list)
    })
  }

  // `export * from`, and `const lib = require("./lib"); module.exports = lib`, whose names are lib's
  const starSpecs = (mod: ParsedModule): string[] => {
    const selfImport =
      mod.self?.kind === "local" ? mod.imports.get(mod.self.name) : undefined
    return selfImport?.name === "*"
      ? [...mod.stars, selfImport.spec]
      : mod.stars
  }

  const exportMemo = new Map<string, number[]>()
  const resolveExport = (
    file: string | undefined,
    name: string,
    depth = 0
  ): number[] => {
    if (!file || depth > STAR_DEPTH) return []
    const mod = modules.get(file)
    if (!mod || !base.has(file)) return []
    const key = `${file}\0${name}`
    const memo = exportMemo.get(key)
    if (memo) return memo
    exportMemo.set(key, [])
    let out: number[] = []
    const t = mod.exports.get(name)
    if (t) out = resolveTarget(mod, t, depth)
    else {
      for (const s of starSpecs(mod)) {
        out = resolveExport(resolveSpec(file, s), name, depth + 1)
        if (out.length > 0) break
      }
      // CommonJS read as ESM: the default import is `module.exports`
      if (out.length === 0 && name === "default")
        out = moduleSelf(file, depth) ?? []
    }
    exportMemo.set(key, out)
    return out
  }

  const allExports = (file: string | undefined, depth = 0): number[] => {
    if (!file) return []
    const mod = modules.get(file)
    if (!mod) return []
    return [...exportNames(file, depth)].flatMap((n) =>
      resolveExport(file, n, depth)
    )
  }

  const exportNames = (file: string, depth = 0): Set<string> => {
    const mod = modules.get(file)
    const out = new Set<string>()
    if (!mod || depth > STAR_DEPTH) return out
    for (const n of mod.exports.keys()) out.add(n)
    for (const s of starSpecs(mod)) {
      const target = resolveSpec(file, s)
      if (target)
        for (const n of exportNames(target, depth + 1))
          if (n !== "default") out.add(n)
    }
    return out
  }

  // What `module.exports = x` makes the module when called: undefined when it never assigns it.
  // `module.exports = require("./lib")` is whatever that module is.
  const moduleSelf = (
    file: string | undefined,
    depth = 0
  ): number[] | undefined => {
    const mod = file ? modules.get(file) : undefined
    if (!mod?.self || !base.has(mod.file) || depth > STAR_DEPTH)
      return undefined
    if (mod.self.kind === "namespace") {
      const target = resolveSpec(mod.file, mod.self.spec)
      return moduleSelf(target, depth + 1) ?? allExports(target, depth + 1)
    }
    return resolveTarget(mod, mod.self, depth + 1)
  }
  // a whole module handed on as a value: whatever it is, and every name it exports
  const moduleValue = (file: string | undefined, depth: number): number[] => [
    ...(moduleSelf(file, depth) ?? []),
    ...allExports(file, depth),
  ]

  const resolveLocal = (
    mod: ParsedModule,
    name: string,
    depth: number,
    use?: "member" | "call"
  ): number[] => {
    const top = mod.top.get(name)
    if (top !== undefined) return [gid(mod.file, top)]
    const imp = mod.imports.get(name)
    if (!imp) return []
    const target = resolveSpec(mod.file, imp.spec)
    if (imp.name !== "*") return resolveExport(target, imp.name, depth + 1)
    return (
      (use === "call" ? moduleSelf(target, depth + 1) : undefined) ??
      moduleValue(target, depth + 1)
    )
  }

  const resolveTarget = (
    mod: ParsedModule,
    t: ExportTarget,
    depth: number
  ): number[] => {
    switch (t.kind) {
      case "unit":
        return [gid(mod.file, t.unit)]
      case "local":
        return resolveLocal(mod, t.name, depth)
      case "import":
        return resolveExport(resolveSpec(mod.file, t.spec), t.name, depth + 1)
      case "namespace":
        return moduleValue(resolveSpec(mod.file, t.spec), depth + 1)
      case "member": {
        if (t.object === "exports")
          return resolveExport(mod.file, t.name, depth + 1)
        const imp = mod.imports.get(t.object)
        // a CommonJS module's default import is `module.exports`, whose properties are its exports
        if (imp?.name === "*" || imp?.name === "default")
          return resolveExport(
            resolveSpec(mod.file, imp.spec),
            t.name,
            depth + 1
          )
        const top = mod.top.get(t.object)
        return top !== undefined
          ? membersOf(gid(mod.file, top), `.${t.name}`, depth + 1)
          : []
      }
    }
  }

  const localOf = (g: number) => {
    const file = units[g]!.file
    return modules.get(file)!.units[g - base.get(file)!]!
  }
  // the units a member of unit g stands for: its own method, or the value the member names
  const membersOf = (g: number, key: string, depth = 0): number[] => {
    const file = units[g]!.file
    const local = localOf(g)
    const m = local.members.get(key)
    if (m !== undefined) return [gid(file, m)]
    const t = local.memberTargets.get(key)
    return t && depth <= STAR_DEPTH
      ? resolveTarget(modules.get(file)!, t, depth + 1)
      : []
  }
  const memberKeys = (g: number): string[] =>
    [
      ...new Set([
        ...localOf(g).members.keys(),
        ...localOf(g).memberTargets.keys(),
      ]),
    ].sort()

  // the call graph: each reference resolved once, conservatively
  for (const [file, mod] of modules) {
    if (!base.has(file)) continue
    mod.units.forEach((u, i) => {
      const calls = new Set<number>(u.children.map((c) => gid(file, c)))
      const members = new Set<string>()
      const lookup = (name: string, use?: "member" | "call"): number[] => {
        for (let p: number | undefined = i; p !== undefined;) {
          const hit = mod.units[p]!.scope.get(name)
          if (hit !== undefined) return [gid(file, hit)]
          p = mod.units[p]!.parent
        }
        return resolveLocal(mod, name, 0, use)
      }
      const classOf = (): number | undefined => {
        for (let p: number | undefined = i; p !== undefined;) {
          const unit: ParsedUnit = mod.units[p]!
          if (unit.owner !== undefined) return unit.owner
          if (unit.kind === "class") return p
          p = unit.parent
        }
        return undefined
      }
      const memberNames = new Set(
        u.refs.flatMap((r) => (r.kind === "member" ? [r.name] : []))
      )
      for (const r of u.refs) {
        if (r.kind === "id") {
          if (r.use === "member" && mod.imports.get(r.name)?.name === "*")
            continue
          for (const g of lookup(r.name, r.use)) {
            calls.add(g)
            // a class handed on as a value can have any method called by whoever receives it
            if (r.use === undefined) {
              for (const m of localOf(g).members.values())
                calls.add(gid(units[g]!.file, m))
              continue
            }
            // `const w = new Watcher(); w.add()`: the methods of a class it names, called by name
            for (const m of memberNames)
              for (const h of [
                ...membersOf(g, `#${m}`),
                ...membersOf(g, `.${m}`),
              ])
                calls.add(h)
          }
          continue
        }
        if (r.kind === "module") {
          for (const g of moduleValue(resolveSpec(file, r.spec), 0))
            calls.add(g)
          continue
        }
        members.add(r.name)
        if (r.object === "this") {
          const c = classOf()
          const own =
            c !== undefined
              ? (mod.units[c]!.members.get(`#${r.name}`) ??
                mod.units[c]!.members.get(`.${r.name}`))
              : undefined
          if (own !== undefined) {
            calls.add(gid(file, own))
            continue
          }
        } else if (r.object !== undefined) {
          const imp = mod.imports.get(r.object)
          if (imp?.name === "*" || imp?.name === "default") {
            for (const g of resolveExport(resolveSpec(file, imp.spec), r.name))
              calls.add(g)
            continue
          }
          const top = mod.top.get(r.object)
          const hits =
            top !== undefined ? membersOf(gid(file, top), `.${r.name}`) : []
          if (hits.length > 0) {
            for (const h of hits) calls.add(h)
            continue
          }
        }
        // a method called on a value the graph lost: every method of that name, when few enough
        const candidates = byMemberName.get(r.name) ?? []
        if (candidates.length <= limits.memberCandidates)
          for (const g of candidates) calls.add(g)
      }
      const g = gid(file, i)
      calls.delete(g)
      units[g]!.calls = [...calls].sort((a, b) => a - b)
      units[g]!.members = [...members].sort()
    })
  }

  // the exports, spelled as the usage scan spells them
  const exports: Record<CanonPath, number[]> = {}
  let exportCount = 0
  const addExport = (path: CanonPath, roots: number[]) => {
    if (roots.length === 0 || exports[path]) return
    if (exportCount >= limits.exports) {
      flags.add("unit-cap")
      return
    }
    exports[path] = [...new Set(roots)].sort((a, b) => a - b)
    exportCount++
  }
  const withMembers = (path: CanonPath, roots: number[]) => {
    addExport(path, roots)
    // an export standing for several units (a whole module) has no members of its own
    const root = roots.length === 1 ? roots[0] : undefined
    if (root === undefined) return
    for (const key of memberKeys(root))
      // `module.exports = fn` with `fn.helper`: the static member reads `lib:helper`
      addExport(
        path.endsWith(":") && key.startsWith(".")
          ? `${path}${key.slice(1)}`
          : `${path}${key}`,
        membersOf(root, key)
      )
  }
  const entryFiles: Record<string, string> = {}
  for (const e of entries) {
    const mod = modules.get(e.file)
    if (!mod) continue
    entryFiles[e.subpath] = e.file
    if (mod.self)
      withMembers(formatPath(pkg, e.subpath, []), moduleSelf(e.file) ?? [])
    for (const name of [...exportNames(e.file)].sort())
      withMembers(
        formatPath(pkg, e.subpath, [{ name, sep: "." }]),
        resolveExport(e.file, name)
      )
  }
  if (Object.keys(exports).length === 0) flags.add("no-entry")

  const facts: ImplementationFacts = {
    pkg,
    version,
    integrity,
    algo: IMPLEMENTATION_ALGO,
    flavor,
    entries: entryFiles,
    units,
    exports,
    flags: [...flags].sort(),
    files: modules.size,
    minified: [...modules.values()]
      .filter((m) => m.minified)
      .map((m) => m.file)
      .sort(),
  }
  return { ok: true, facts }
}

// Every unit an export may run, breadth first from its roots, bounded.
export function reach(
  facts: ImplementationFacts,
  path: CanonPath,
  cap = 20_000
): number[] {
  const roots = facts.exports[path] ?? []
  const seen = new Set<number>(roots)
  const queue = [...roots]
  while (queue.length > 0 && seen.size < cap) {
    const u = facts.units[queue.shift()!]
    if (!u) continue
    for (const c of u.calls)
      if (!seen.has(c)) {
        seen.add(c)
        queue.push(c)
      }
  }
  return [...seen].sort((a, b) => a - b)
}

export function shortName(qualified: string): string {
  return qualified.slice(
    Math.max(
      qualified.lastIndexOf("/"),
      qualified.lastIndexOf("#"),
      qualified.lastIndexOf(".")
    ) + 1
  )
}

// The names an export's code declares or calls: what a note naming an internal function may mean.
export function reachableNames(
  facts: ImplementationFacts,
  path: CanonPath
): { declared: Set<string>; called: Set<string> } {
  const declared = new Set<string>()
  const called = new Set<string>()
  for (const i of reach(facts, path)) {
    const u = facts.units[i]!
    declared.add(shortName(u.name))
    for (const m of u.members) called.add(m)
  }
  return { declared, called }
}
