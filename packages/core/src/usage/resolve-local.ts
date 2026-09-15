import { join, posix } from "node:path"
import { builtinModules } from "node:module"
import { existsSync, readFileSync } from "node:fs"

import ts from "typescript"

import { relPath } from "../inventory/manifests.ts"
import type { InstalledDep, Inventory } from "../model.ts"
import { packageNameOf, subpathOf } from "../inventory/specifiers.ts"
import {
  lockDirFor,
  projectBoundary,
  resolveInstalled,
} from "../inventory/installed.ts"

export type Target =
  | { kind: "file"; rel: string }
  | { kind: "pkg"; installedId: string; pkg: string; entry: string }
  | { kind: "builtin" }
  | { kind: "unresolved-local" }
  | { kind: "unknown" }

const EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
]
const BUILTINS = new Set(builtinModules)

interface PathsConfig {
  dir: string
  baseUrl?: string
  paths: [string, string[]][]
}

export class LocalResolver {
  private readonly fileSet: Set<string>
  private readonly boundary: string
  private readonly installCache = new Map<
    string,
    Promise<Awaited<ReturnType<typeof resolveInstalled>>>
  >()
  private readonly configCache = new Map<string, PathsConfig | undefined>()
  private readonly byName = new Map<string, InstalledDep[]>()
  private readonly root: string
  private readonly inventory: Inventory

  constructor(root: string, files: string[], inventory: Inventory) {
    this.root = root
    this.inventory = inventory
    this.fileSet = new Set(files)
    this.boundary = projectBoundary(root)
    for (const d of inventory.installed) {
      const list = this.byName.get(d.name) ?? []
      list.push(d)
      this.byName.set(d.name, list)
      for (const by of d.declaredBy) {
        if (by.key !== d.name) {
          const alias = this.byName.get(by.key) ?? []
          if (!alias.includes(d)) alias.push(d)
          this.byName.set(by.key, alias)
        }
      }
    }
  }

  async resolve(fromRel: string, specifier: string): Promise<Target> {
    if (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier === "." ||
      specifier === ".."
    ) {
      const hit = this.tryFile(posix.join(posix.dirname(fromRel), specifier))
      return hit ? { kind: "file", rel: hit } : { kind: "unresolved-local" }
    }
    if (
      specifier.startsWith("node:") ||
      BUILTINS.has(specifier) ||
      BUILTINS.has(specifier.split("/")[0]!)
    ) {
      return { kind: "builtin" }
    }
    const viaPaths = this.fromTsconfigPaths(fromRel, specifier)
    if (viaPaths) return { kind: "file", rel: viaPaths }

    const pkg = packageNameOf(specifier)
    if (!pkg) {
      return looksLikeAlias(specifier)
        ? { kind: "unresolved-local" }
        : { kind: "unknown" }
    }
    const fromDir = join(this.root, posix.dirname(fromRel))
    const key = `${fromDir}\0${pkg}`
    let p = this.installCache.get(key)
    if (!p) {
      // as the inventory does: never past the folder of a separate install's lockfile
      p = resolveInstalled(
        fromDir,
        pkg,
        lockDirFor(fromDir, this.boundary) ?? this.boundary
      )
      this.installCache.set(key, p)
    }
    const found = await p
    if (found) {
      if (found.local) {
        const rel = this.workspaceEntry(
          found.realDir,
          subpathOf(specifier, pkg)
        )
        return rel ? { kind: "file", rel } : { kind: "unresolved-local" }
      }
      const dep = this.inventory.installed.find((d) => d.id === found.realDir)
      return {
        kind: "pkg",
        installedId: found.realDir,
        pkg: dep?.name ?? found.name,
        entry: subpathOf(specifier, pkg),
      }
    }
    // nothing on disk: attribute to the version the inventory read from a lockfile or a range
    const candidates = this.byName.get(pkg)
    if (candidates && candidates.length > 0) {
      const dep = this.nearestDeclared(fromRel, candidates)
      return {
        kind: "pkg",
        installedId: dep.id,
        pkg: dep.name,
        entry: subpathOf(specifier, pkg),
      }
    }
    const ws = this.inventory.manifests.find((m) => m.name === pkg)
    if (ws) {
      const rel = this.workspaceEntry(ws.dir, subpathOf(specifier, pkg))
      if (rel) return { kind: "file", rel }
    }
    return looksLikeAlias(specifier)
      ? { kind: "unresolved-local" }
      : { kind: "unknown" }
  }

  private nearestDeclared(fromRel: string, deps: InstalledDep[]): InstalledDep {
    let best = deps[0]!
    let bestLen = -1
    for (const d of deps) {
      for (const by of d.declaredBy) {
        const dir = posix.dirname(by.manifest)
        const prefix = dir === "." ? "" : `${dir}/`
        if (fromRel.startsWith(prefix) && prefix.length > bestLen) {
          best = d
          bestLen = prefix.length
        }
      }
    }
    return best
  }

  tryFile(rel: string): string | undefined {
    const norm = posix.normalize(rel).replace(/^\.\//, "")
    if (this.fileSet.has(norm)) return norm
    for (const ext of EXTS) if (this.fileSet.has(norm + ext)) return norm + ext
    // ESM TypeScript writes the emitted extension: ./a.js means ./a.ts
    const swap = /\.(m|c)?jsx?$/.exec(norm)
    if (swap) {
      const base = norm.slice(0, -swap[0].length)
      const m = swap[1] ?? ""
      for (const ext of [`.${m}ts`, `.${m}tsx`, ".ts", ".tsx"])
        if (this.fileSet.has(base + ext)) return base + ext
    }
    for (const ext of EXTS)
      if (this.fileSet.has(`${norm}/index${ext}`)) return `${norm}/index${ext}`
    return undefined
  }

  private workspaceEntry(absDir: string, subpath: string): string | undefined {
    const dirRel = relPath(this.root, absDir)
    if (dirRel.startsWith("..")) return undefined
    const pjPath = join(absDir, "package.json")
    let pj: {
      exports?: unknown
      main?: string
      module?: string
      types?: string
    } = {}
    try {
      pj = JSON.parse(readFileSync(pjPath, "utf8")) as typeof pj
    } catch {
      // folder without a manifest: fall back to index files
    }
    const base = dirRel === "." ? "" : `${dirRel}/`
    const targets: string[] = []
    if (pj.exports !== undefined) {
      const t = exportsTarget(pj.exports, subpath)
      if (t) targets.push(t)
    } else if (subpath === ".") {
      for (const f of [pj.types, pj.module, pj.main]) if (f) targets.push(f)
      targets.push("index")
    } else {
      targets.push(subpath)
    }
    for (const t of targets) {
      const hit = this.tryFile(base + t.replace(/^\.\//, ""))
      if (hit) return hit
      // a manifest pointing at dist/ that was never built: its sources are the next best answer
      const src = t.replace(/^\.?\/?(dist|build|lib|out)\//, "src/")
      const hit2 =
        src !== t ? this.tryFile(base + src.replace(/\.d\.ts$/, "")) : undefined
      if (hit2) return hit2
    }
    return undefined
  }

  private fromTsconfigPaths(
    fromRel: string,
    specifier: string
  ): string | undefined {
    const cfg = this.pathsConfigFor(posix.dirname(fromRel))
    if (!cfg) return undefined
    for (const [pattern, subs] of cfg.paths) {
      const star = pattern.indexOf("*")
      let captured: string | undefined
      if (star < 0) {
        if (pattern === specifier) captured = ""
      } else {
        const pre = pattern.slice(0, star)
        const post = pattern.slice(star + 1)
        if (
          specifier.startsWith(pre) &&
          specifier.endsWith(post) &&
          specifier.length >= pre.length + post.length
        ) {
          captured = specifier.slice(pre.length, specifier.length - post.length)
        }
      }
      if (captured === undefined) continue
      for (const sub of subs) {
        const rel = posix.join(
          cfg.baseUrl ?? cfg.dir,
          sub.replace("*", captured)
        )
        const hit = this.tryFile(rel)
        if (hit) return hit
      }
    }
    if (
      cfg.baseUrl &&
      !specifier.startsWith("@") &&
      !packageNameOf(specifier)?.includes(".")
    ) {
      const hit = this.tryFile(posix.join(cfg.baseUrl, specifier))
      if (hit && !this.byName.has(packageNameOf(specifier) ?? "")) return hit
    }
    return undefined
  }

  private pathsConfigFor(dirRel: string): PathsConfig | undefined {
    if (this.configCache.has(dirRel)) return this.configCache.get(dirRel)
    let result: PathsConfig | undefined
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const rel = dirRel === "." ? name : `${dirRel}/${name}`
      if (existsSync(join(this.root, rel))) {
        result = this.readPathsConfig(rel, 0)
        break
      }
    }
    if (!result && dirRel !== "." && dirRel !== "") {
      const parent = posix.dirname(dirRel)
      result = this.pathsConfigFor(parent === dirRel ? "." : parent)
    }
    this.configCache.set(dirRel, result)
    return result
  }

  private readPathsConfig(rel: string, depth: number): PathsConfig | undefined {
    if (depth > 5) return undefined
    let json: {
      extends?: string | string[]
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
    }
    try {
      json =
        (ts.parseConfigFileTextToJson(
          rel,
          readFileSync(join(this.root, rel), "utf8")
        ).config as typeof json | undefined) ?? {}
    } catch {
      return undefined
    }
    const dir = posix.dirname(rel)
    let inherited: PathsConfig | undefined
    for (const ext of [json.extends].flat()) {
      if (typeof ext !== "string" || !ext.startsWith(".")) continue
      const target = posix.join(
        dir,
        ext.endsWith(".json") ? ext : `${ext}.json`
      )
      inherited = this.readPathsConfig(target, depth + 1) ?? inherited
    }
    const co = json.compilerOptions ?? {}
    const baseUrl =
      co.baseUrl !== undefined
        ? posix.join(dir, co.baseUrl)
        : inherited?.baseUrl
    const paths = co.paths
      ? Object.entries(co.paths).map(([k, v]) => [k, v] as [string, string[]])
      : (inherited?.paths ?? [])
    // paths without baseUrl resolve against the config that declares them
    const pathsDir = co.paths ? dir : (inherited?.dir ?? dir)
    if (!baseUrl && paths.length === 0) return undefined
    return { dir: pathsDir, ...(baseUrl ? { baseUrl } : {}), paths }
  }
}

function looksLikeAlias(specifier: string): boolean {
  return /^(@\/|~\/|#|\$)/.test(specifier) || specifier.startsWith("@/")
}

export function exportsTarget(
  exp: unknown,
  subpath: string
): string | undefined {
  const conditions = [
    "types",
    "import",
    "module",
    "default",
    "require",
    "node",
    "browser",
  ]
  const pick = (v: unknown, star?: string): string | undefined => {
    if (typeof v === "string")
      return star !== undefined ? v.replace(/\*/g, star) : v
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = pick(x, star)
        if (r) return r
      }
      return undefined
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>
      for (const c of conditions)
        if (c in o) {
          const r = pick(o[c], star)
          if (r) return r
        }
      for (const [k, x] of Object.entries(o))
        if (!k.startsWith(".") && !conditions.includes(k)) {
          const r = pick(x, star)
          if (r) return r
        }
    }
    return undefined
  }
  if (typeof exp === "string" || Array.isArray(exp))
    return subpath === "." ? pick(exp) : undefined
  if (!exp || typeof exp !== "object") return undefined
  const map = exp as Record<string, unknown>
  const keys = Object.keys(map)
  if (!keys.some((k) => k.startsWith(".")))
    return subpath === "." ? pick(map) : undefined
  if (subpath in map) return pick(map[subpath])
  for (const k of keys) {
    const star = k.indexOf("*")
    if (star < 0) continue
    const pre = k.slice(0, star)
    const post = k.slice(star + 1)
    if (subpath.startsWith(pre) && subpath.endsWith(post))
      return pick(
        map[k],
        subpath.slice(pre.length, subpath.length - post.length)
      )
  }
  return undefined
}
