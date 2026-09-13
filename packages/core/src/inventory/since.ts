import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { dirname, join } from "node:path"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"

import semver from "semver"

import { relPath, SKIP_DIRS } from "./manifests.ts"
import type { InstalledDep, Inventory, NotAnalyzed } from "../model.ts"

const run = promisify(execFile)

// What decides a dependency's version at a commit. Source files are never needed: usage is
// always read from the working tree, the code that will run after the change.
const VERSION_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  ".pnp.cjs",
  ".pnp.js",
])

export interface BaseTree {
  dir: string
  ref: string
  commit: string
  cleanup: () => Promise<void>
}

// Writes the manifests and lockfiles of the whole repository at `ref` into a temporary folder, and
// points at the folder `root` maps to inside it: a package of a monorepo reads the lockfile at the
// repository root, as it does in the working tree. Nothing is installed there, so versions come
// from the lockfile.
export async function readBaseTree(
  root: string,
  ref: string
): Promise<BaseTree> {
  const git = (args: string[]) =>
    run("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 })
  let commit: string
  try {
    commit = (
      await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    ).stdout.trim()
  } catch {
    throw new Error(
      `--since ${ref}: no such commit here (not a git repository, or the ref is not fetched)`
    )
  }
  const prefix = (await git(["rev-parse", "--show-prefix"])).stdout.trim()
  const { stdout } = await git([
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "--name-only",
    commit,
  ])
  const paths = stdout.split("\0").filter((p) => {
    const segs = p.split("/")
    return (
      VERSION_FILES.has(segs.at(-1) ?? "") &&
      !segs.slice(0, -1).some((s) => SKIP_DIRS.has(s))
    )
  })

  const top = await mkdtemp(join(tmpdir(), "radius-since-"))
  // bounds the node_modules and lockfile walks, as the real repository does
  await mkdir(join(top, ".git"))
  for (const rel of paths) {
    const { stdout: content } = await run("git", ["show", `${commit}:${rel}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    })
    await mkdir(dirname(join(top, rel)), { recursive: true })
    await writeFile(join(top, rel), content)
  }
  const dir = join(top, prefix)
  await mkdir(dir, { recursive: true })
  return {
    dir,
    ref,
    commit,
    cleanup: () => rm(top, { recursive: true, force: true }),
  }
}

export interface SincePlan {
  // the dependency as it is now, carrying the version it had at the ref; `to` is the version now
  changed: { dep: InstalledDep; to: string }[]
  unchanged: number
  added: NotAnalyzed[]
}

// Pairs each dependency of the working tree with the same dependency at the ref, where the same
// manifest declares it under the same key. Declared somewhere new, it counts as added, even when
// another manifest has an older version: that one is paired on its own.
export function planSince(
  now: InstalledDep[],
  base: Pick<Inventory, "installed" | "manifests" | "root">,
  ref: string
): SincePlan {
  const plan: SincePlan = { changed: [], unchanged: 0, added: [] }
  const declaration = (manifest: string, key: string) => `${manifest}\0${key}`
  const declaredAtRef = new Set(
    base.manifests.flatMap((m) =>
      m.deps.map((d) => declaration(relPath(base.root, m.path), d.key))
    )
  )
  for (const dep of now) {
    const pool = base.installed.filter(
      (b) =>
        b.name === dep.name &&
        b.declaredBy.some((bd) =>
          dep.declaredBy.some(
            (d) => d.manifest === bd.manifest && d.key === bd.key
          )
        )
    )
    if (pool.length === 0) {
      plan.added.push({
        pkg: dep.name,
        reason: dep.declaredBy.some((d) =>
          declaredAtRef.has(declaration(d.manifest, d.key))
        )
          ? `its version at ${ref} is unknown (no lockfile entry), so there is nothing to compare`
          : `added since ${ref}, so there is no earlier version to compare`,
      })
      continue
    }
    if (pool.some((b) => b.version === dep.version)) {
      plan.unchanged++
      continue
    }
    // several earlier versions: the lowest one, so the compared range covers every change
    const prev = [...pool].sort((a, b) =>
      semver.valid(a.version) && semver.valid(b.version)
        ? semver.compare(a.version, b.version)
        : a.version.localeCompare(b.version)
    )[0]!
    plan.changed.push({
      dep: {
        ...dep,
        version: prev.version,
        versionSource: prev.versionSource,
        flags: [...new Set([...dep.flags, ...prev.flags])],
      },
      to: dep.version,
    })
  }
  return plan
}
