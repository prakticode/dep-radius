import { existsSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { readdir, readFile, realpath } from "node:fs/promises"

import semver from "semver"

import { bunLock } from "./lockfiles/bun.ts"
import { npmLock } from "./lockfiles/npm.ts"
import { pnpmLock } from "./lockfiles/pnpm.ts"
import { yarnLock } from "./lockfiles/yarn.ts"
import type { LockReader } from "./lockfiles/types.ts"
import { findManifests, listProjectFiles, relPath } from "./manifests.ts"
import type {
  DeclaredDep,
  InstalledDep,
  Inventory,
  Manifest,
  NotAnalyzed,
  OutOfSync,
} from "../model.ts"

export interface InventoryOptions {
  prod: boolean
}

export interface ResolvedInstall {
  dir: string
  realDir: string
  name: string
  version: string
  local: boolean
}

// Walks up node_modules from `fromDir` exactly as Node does, stopping at the project boundary.
export async function resolveInstalled(
  fromDir: string,
  key: string,
  stopAt: string
): Promise<ResolvedInstall | undefined> {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, "node_modules", key)
    const pj = join(candidate, "package.json")
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(await readFile(pj, "utf8")) as {
          name?: string
          version?: string
        }
        const realDir = await realpath(candidate)
        const local = !realDir.split(sep).includes("node_modules")
        return {
          dir: candidate,
          realDir,
          name: json.name ?? key,
          version: json.version ?? "0.0.0",
          local,
        }
      } catch {
        return undefined
      }
    }
    if (dir === stopAt) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

interface FoundLock {
  reader: LockReader
  // the folder of the lockfile: its entries are keyed by paths relative to it
  dir: string
}

const LOCKFILES: [string, (t: string) => LockReader | undefined][] = [
  ["pnpm-lock.yaml", pnpmLock],
  ["package-lock.json", npmLock],
  ["npm-shrinkwrap.json", npmLock],
  ["yarn.lock", yarnLock],
  ["bun.lock", bunLock],
]

// The folder of the nearest lockfile, from `dir` up to `stopAt`. A folder with a lockfile of its own
// is installed on its own (a `functions/` folder next to a web app, say): its dependencies are not
// the ones of the folders above it, and Node finds them in its own node_modules.
export function lockDirFor(dir: string, stopAt: string): string | undefined {
  let d = dir
  for (;;) {
    if (LOCKFILES.some(([file]) => existsSync(join(d, file)))) return d
    if (d === stopAt) return undefined
    const parent = dirname(d)
    if (parent === d) return undefined
    d = parent
  }
}

// The nearest lockfile, from a manifest's folder up to the repository root: a package of a
// monorepo has none of its own and reads the root one, a separately installed folder reads its
// own. Outside a repository the walk stops at `root`, so a stray lockfile in a parent folder never
// answers for a project.
async function loadLock(
  from: string,
  root: string
): Promise<FoundLock | undefined> {
  const boundary = projectBoundary(root)
  const stopAt = existsSync(join(boundary, ".git")) ? boundary : root
  let dir = from
  for (;;) {
    for (const [file, reader] of LOCKFILES) {
      const p = join(dir, file)
      if (!existsSync(p)) continue
      try {
        const r = reader(await readFile(p, "utf8"))
        if (r) return { reader: r, dir }
      } catch {
        // unreadable lockfile: fall through to the next source
      }
    }
    if (dir === stopAt) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// Packages the project forces to another version: npm `overrides`, yarn `resolutions`, pnpm
// `pnpm.overrides` or the `overrides` of pnpm-workspace.yaml. Their lockfile entries legitimately
// disagree with the manifest. Selectors such as `a>b`, `**/b` or `b@<2` name b; a name read too
// widely only means one fewer check.
async function overriddenNames(dirs: string[]): Promise<Set<string>> {
  const names = new Set<string>()
  const add = (selector: string) => {
    const last = selector.split(">").at(-1)?.split("**/").at(-1)?.trim() ?? ""
    const scoped = /^(@[^/@]+\/[^/@]+)/.exec(last)
    const name =
      scoped?.[1] ?? /^([^/@]+)/.exec(last.split("/").at(-1) ?? "")?.[1]
    if (name) names.add(name)
  }
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return
    for (const [k, v] of Object.entries(value)) {
      if (k !== ".") add(k)
      walk(v)
    }
  }
  for (const dir of dirs) {
    try {
      const pj = JSON.parse(
        await readFile(join(dir, "package.json"), "utf8")
      ) as {
        overrides?: unknown
        resolutions?: unknown
        pnpm?: { overrides?: unknown }
      }
      walk(pj.overrides)
      walk(pj.resolutions)
      walk(pj.pnpm?.overrides)
    } catch {
      // no manifest here
    }
    try {
      const ws = await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")
      const block = /^overrides:\s*\n((?:[ \t]+.*\n?)*)/m.exec(ws)
      for (const line of block?.[1]?.split("\n") ?? []) {
        const m = /^\s+['"]?([^'":]+?)['"]?\s*:/.exec(line)
        if (m?.[1]) add(m[1])
      }
    } catch {
      // no workspace file
    }
  }
  return names
}

async function patchedNames(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  try {
    for (const f of await readdir(join(root, "patches"))) {
      // patch-package: name+1.2.3.patch, @scope+name+1.2.3.patch ; pnpm: name@1.2.3.patch, @scope__name@1.2.3.patch
      const pp = /^(.+)\+\d[^+]*\.patch$/.exec(f)
      if (pp?.[1]) names.add(pp[1].replace(/^(@[^+]+)\+/, "$1/"))
      const pn = /^(.+)@\d.*\.patch$/.exec(f)
      if (pn?.[1]) names.add(pn[1].replace(/^(@[^_]+)__/, "$1/"))
    }
  } catch {
    // no patches folder
  }
  try {
    const pj = JSON.parse(
      await readFile(join(root, "package.json"), "utf8")
    ) as {
      pnpm?: { patchedDependencies?: Record<string, string> }
    }
    for (const k of Object.keys(pj.pnpm?.patchedDependencies ?? {}))
      names.add(k.replace(/@[^@]*$/, "") || k)
  } catch {
    // no root manifest
  }
  try {
    const ws = await readFile(join(root, "pnpm-workspace.yaml"), "utf8")
    const block = /^patchedDependencies:\s*\n((?:[ \t]+.*\n?)*)/m.exec(ws)
    for (const line of block?.[1]?.split("\n") ?? []) {
      const m = /^\s+['"]?(@?[^@'":\s]+)(?:@[^'":]*)?['"]?:/.exec(line)
      if (m?.[1]) names.add(m[1])
    }
  } catch {
    // no workspace file
  }
  return names
}

// Node walks to the filesystem root; the walk stops at the enclosing git root instead, so a
// stray ~/node_modules never answers for a project.
export function projectBoundary(root: string): string {
  let dir = root
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

export async function buildInventory(
  root: string,
  opts: InventoryOptions,
  files?: string[]
): Promise<Inventory> {
  const projectFiles = files ?? (await listProjectFiles(root))
  const manifests = await findManifests(root, projectFiles)
  const patched = await patchedNames(root)
  // one install per lockfile: its versions, its overrides, its Plug'n'Play
  const installs = new Map<
    string,
    Promise<{
      lock: FoundLock | undefined
      overridden: Set<string>
      hasPnp: boolean
    }>
  >()
  const installFor = (dir: string) => {
    let p = installs.get(dir)
    if (!p) {
      p = (async () => {
        const lock = await loadLock(dir, root)
        const lockDir = lock?.dir ?? root
        return {
          lock,
          overridden: await overriddenNames([...new Set([root, lockDir])]),
          hasPnp:
            existsSync(join(lockDir, ".pnp.cjs")) ||
            existsSync(join(lockDir, ".pnp.js")),
        }
      })()
      installs.set(dir, p)
    }
    return p
  }

  const byId = new Map<string, InstalledDep>()
  const local = new Set<string>()
  const notAnalyzed = new Map<string, NotAnalyzed>()
  const workspaceNames = new Set(
    manifests.map((m) => m.name).filter((n): n is string => !!n)
  )

  for (const m of manifests) {
    for (const d of m.deps) {
      if (
        d.field === "peerDependencies" &&
        !m.deps.some((o) => o.key === d.key && o.field !== "peerDependencies")
      )
        continue
      if (opts.prod && d.field === "devDependencies") continue
      if (
        d.specKind === "workspace" ||
        d.specKind === "link" ||
        d.specKind === "file"
      ) {
        local.add(d.key)
        continue
      }
      if (d.specKind === "git" || d.specKind === "url") {
        notAnalyzed.set(d.key, {
          pkg: d.key,
          reason: `installed from ${d.specKind} (${d.spec}), not from a registry`,
        })
        continue
      }
      const { lock, hasPnp, overridden } = await installFor(m.dir)
      const found = await resolveDep(root, m, d, lock, hasPnp, overridden)
      if (!found) {
        if (workspaceNames.has(d.key)) local.add(d.key)
        else
          notAnalyzed.set(d.key, {
            pkg: d.key,
            reason:
              d.specKind === "catalog"
                ? "not installed and declared through catalog:, so the version is unknown"
                : "not installed, not in a lockfile, and the range gives no version",
          })
        continue
      }
      if (found.local) {
        local.add(d.key)
        continue
      }
      let dep = byId.get(found.id)
      if (!dep) {
        dep = found
        byId.set(found.id, dep)
      } else if (found.outOfSync) {
        dep.outOfSync = [...(dep.outOfSync ?? []), ...found.outOfSync]
      }
      dep.declaredBy.push({
        manifest: relPath(root, m.path),
        key: d.key,
        field: d.field,
      })
      if (patched.has(dep.name) && !dep.flags.includes("patched"))
        dep.flags.push("patched")
    }
  }

  for (const dep of byId.values()) notAnalyzed.delete(dep.name)
  return {
    root,
    manifests,
    installed: [...byId.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
    ),
    local: [...local].sort(),
    notAnalyzed: [...notAnalyzed.values()].sort((a, b) =>
      a.pkg.localeCompare(b.pkg)
    ),
  }
}

async function resolveDep(
  root: string,
  m: Manifest,
  d: DeclaredDep,
  lock: FoundLock | undefined,
  hasPnp: boolean,
  overridden: Set<string>
): Promise<InstalledDep | undefined> {
  const outOfSync: OutOfSync[] = []
  const withSkipped = (dep: InstalledDep): InstalledDep =>
    outOfSync.length > 0 ? { ...dep, outOfSync } : dep

  // What the manifest installs this key with: a peer range beside a real declaration is not installed.
  const installing = m.deps.filter(
    (o) => o.key === d.key && o.field !== "peerDependencies"
  )
  const declarations = installing.length > 0 ? installing : [d]
  const allowed = (version: string) =>
    declarations.some((o) => allowedBy(o)(version))

  // A lockfile written for another specifier predates the manifest: `npm ci` refuses it, and the
  // next install replaces the version. A bot pull request that bumps a pin without refreshing the
  // lockfile leaves exactly that. The specifier alone cannot tell, since an override or a catalog
  // is recorded under its own value, so a stale entry must also fall outside the declared range,
  // and an overridden package is never judged.
  const hit = lock?.reader.lookup(relPath(lock.dir, m.dir), d.key, d.spec)
  const recorded =
    hit?.specifier !== undefined &&
    declarations.some((o) => o.spec === hit.specifier)
  const lockStale =
    hit !== undefined &&
    hit.specifier !== undefined &&
    !recorded &&
    !overridden.has(d.key) &&
    !allowed(hit.version)

  if (!hasPnp) {
    // node_modules is looked up to the folder of the lockfile, never past a separate install
    const r = await resolveInstalled(
      m.dir,
      d.key,
      lock?.dir ?? projectBoundary(root)
    )
    // node_modules is behind the project when it differs from a lockfile written for this very
    // specifier, or, with a stale lockfile too, when the manifest does not even allow it. A linked
    // workspace package is the project's own code, whatever version it carries.
    const behind =
      !!r &&
      !r.local &&
      !!hit &&
      (lockStale ? !allowed(r.version) : recorded && hit.version !== r.version)
    if (r && behind)
      outOfSync.push({
        source: "node_modules",
        version: r.version,
        spec: d.spec,
      })
    if (r && !behind) {
      const flags: InstalledDep["flags"] = []
      if (r.name !== d.key) flags.push("alias")
      if (semver.prerelease(r.version)) flags.push("prerelease-installed")
      return withSkipped({
        id: r.realDir,
        name: r.name,
        version: r.version,
        versionSource: "node_modules",
        dir: r.realDir,
        local: r.local,
        declaredBy: [],
        flags,
      })
    }
  }
  if (lock && hit && lockStale)
    outOfSync.push({
      source: lock.reader.source,
      version: hit.version,
      spec: d.spec,
    })
  if (lock && hit && !lockStale) {
    const flags: InstalledDep["flags"] = []
    if (hit.name !== d.key) flags.push("alias")
    return withSkipped({
      // the lockfile's folder is part of the id: two separate installs that happen to hold the
      // same version are still two copies, one of which may have moved
      id: `${lock.reader.source}:${relPath(root, lock.dir) || "."}:${hit.name}@${hit.version}`,
      name: hit.name,
      version: hit.version,
      versionSource: lock.reader.source,
      local: false,
      declaredBy: [],
      flags,
    })
  }
  const range = rangeOf(d)
  if (d.specKind === "range" || d.specKind === "alias") {
    const min = semver.validRange(range) ? semver.minVersion(range) : null
    if (min) {
      const name = d.aliasOf ?? d.key
      return withSkipped({
        id: `manifest-range:${name}@${min.version}`,
        name,
        version: min.version,
        versionSource: "manifest-range",
        local: false,
        declaredBy: [],
        flags: ["range-guess", ...(d.aliasOf ? (["alias"] as const) : [])],
      })
    }
  }
  return undefined
}

function rangeOf(d: DeclaredDep): string {
  return d.specKind === "alias" ? d.spec.replace(/^npm:.*@/, "") : d.spec
}

// Whether a version is one the declaration allows. Only a range can say no: a tag, a catalog entry
// or a bare alias names no version. A prerelease inside the range is allowed, as when a project
// installs a release candidate of the version it declares.
function allowedBy(d: DeclaredDep): (version: string) => boolean {
  const range = rangeOf(d)
  if (
    (d.specKind !== "range" && d.specKind !== "alias") ||
    !semver.validRange(range)
  )
    return () => true
  return (version) =>
    !semver.valid(version) ||
    semver.satisfies(version, range, { includePrerelease: true })
}
