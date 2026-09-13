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

async function loadLock(root: string): Promise<LockReader | undefined> {
  const tries: [string, (t: string) => LockReader | undefined][] = [
    ["pnpm-lock.yaml", pnpmLock],
    ["package-lock.json", npmLock],
    ["npm-shrinkwrap.json", npmLock],
    ["yarn.lock", yarnLock],
    ["bun.lock", bunLock],
  ]
  for (const [file, reader] of tries) {
    const p = join(root, file)
    if (!existsSync(p)) continue
    try {
      const r = reader(await readFile(p, "utf8"))
      if (r) return r
    } catch {
      // unreadable lockfile: fall through to the next source
    }
  }
  return undefined
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
  const lock = await loadLock(root)
  const patched = await patchedNames(root)
  const hasPnp =
    existsSync(join(root, ".pnp.cjs")) || existsSync(join(root, ".pnp.js"))

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
      const found = await resolveDep(root, m, d, lock, hasPnp)
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
  lock: LockReader | undefined,
  hasPnp: boolean
): Promise<InstalledDep | undefined> {
  if (!hasPnp) {
    const r = await resolveInstalled(m.dir, d.key, projectBoundary(root))
    if (r) {
      const flags: InstalledDep["flags"] = []
      if (r.name !== d.key) flags.push("alias")
      if (semver.prerelease(r.version)) flags.push("prerelease-installed")
      return {
        id: r.realDir,
        name: r.name,
        version: r.version,
        versionSource: "node_modules",
        dir: r.realDir,
        local: r.local,
        declaredBy: [],
        flags,
      }
    }
  }
  if (lock) {
    const hit = lock.lookup(relPath(root, m.dir), d.key, d.spec)
    if (hit) {
      const flags: InstalledDep["flags"] = []
      if (hit.name !== d.key) flags.push("alias")
      return {
        id: `${lock.source}:${hit.name}@${hit.version}`,
        name: hit.name,
        version: hit.version,
        versionSource: lock.source,
        local: false,
        declaredBy: [],
        flags,
      }
    }
  }
  const range = d.specKind === "alias" ? d.spec.replace(/^npm:.*@/, "") : d.spec
  if (d.specKind === "range" || d.specKind === "alias") {
    const min = semver.validRange(range) ? semver.minVersion(range) : null
    if (min) {
      const name = d.aliasOf ?? d.key
      return {
        id: `manifest-range:${name}@${min.version}`,
        name,
        version: min.version,
        versionSource: "manifest-range",
        local: false,
        declaredBy: [],
        flags: ["range-guess", ...(d.aliasOf ? (["alias"] as const) : [])],
      }
    }
  }
  return undefined
}
