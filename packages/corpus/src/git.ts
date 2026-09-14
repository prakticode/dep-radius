import { join } from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"

const exec = promisify(execFile)

// What a snapshot holds with content: what radius reads. Everything else stays in the index only,
// so `git ls-files` still lists it and an import of an asset resolves to a file that exists.
export const SNAPSHOT_PATTERNS = [
  "package.json",
  "tsconfig*.json",
  "jsconfig*.json",
  ".npmrc",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  ".pnp.cjs",
  ".pnp.js",
  "*.js",
  "*.jsx",
  "*.ts",
  "*.tsx",
  "*.mjs",
  "*.cjs",
  "*.mts",
  "*.cts",
  "*.vue",
  "*.svelte",
  "*.astro",
  "*.css",
  "*.scss",
]

// The files that decide a dependency's version, as `radius --since` reads them at the base commit.
export const VERSION_FILE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lock|\.pnp\.c?js)$/

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 15 * 60_000,
  })
  return stdout
}

// One partial clone per repository, shared by every case of it: commits and trees are fetched
// without history, and a blob only when something reads it.
export class Repo {
  readonly dir: string
  readonly name: string

  constructor(data: string, name: string) {
    this.name = name
    this.dir = join(data, "repos", name.replace("/", "__"))
  }

  async ensure(): Promise<void> {
    if (existsSync(join(this.dir, ".git"))) return
    mkdirSync(this.dir, { recursive: true })
    await git(this.dir, ["init", "-q"])
    await git(this.dir, [
      "remote",
      "add",
      "origin",
      `https://github.com/${this.name}.git`,
    ])
    await git(this.dir, ["config", "remote.origin.promisor", "true"])
    await git(this.dir, [
      "config",
      "remote.origin.partialclonefilter",
      "blob:none",
    ])
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }

  async has(sha: string): Promise<boolean> {
    try {
      await git(this.dir, ["cat-file", "-e", `${sha}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  // GitHub serves any commit a pull request ever pointed at, even once its branch is deleted.
  async fetchCommits(shas: string[]): Promise<void> {
    await this.ensure()
    const missing: string[] = []
    for (const s of new Set(shas)) if (!(await this.has(s))) missing.push(s)
    if (missing.length === 0) return
    await git(this.dir, [
      "fetch",
      "-q",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      ...missing,
    ])
  }

  // Asks for the blobs of these paths in one round trip; otherwise git fetches each one alone the
  // first time it is read.
  async prefetch(
    commit: string,
    keep: (path: string) => boolean
  ): Promise<void> {
    const listing = await git(this.dir, ["ls-tree", "-r", "-z", commit])
    const wanted = new Set<string>()
    for (const entry of listing.split("\0")) {
      const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(entry)
      if (m && keep(m[2]!)) wanted.add(m[1]!)
    }
    if (wanted.size === 0) return
    const missing = new Set(
      (
        await git(this.dir, [
          "rev-list",
          "--objects",
          "--missing=print",
          "--no-object-names",
          commit,
        ])
      )
        .split("\n")
        .filter((l) => l.startsWith("?"))
        .map((l) => l.slice(1))
    )
    const need = [...wanted].filter((o) => missing.has(o))
    for (let i = 0; i < need.length; i += 1000)
      await git(this.dir, [
        "fetch",
        "-q",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        ...need.slice(i, i + 1000),
      ])
  }

  async show(commit: string, path: string): Promise<string | undefined> {
    try {
      return await git(this.dir, ["show", `${commit}:${path}`])
    } catch {
      return undefined
    }
  }

  async changedPaths(from: string, to: string): Promise<string[]> {
    return (
      await git(this.dir, [
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        from,
        to,
      ])
    )
      .split("\0")
      .filter(Boolean)
  }

  async diff(from: string, to: string, paths: string[]): Promise<string> {
    if (paths.length === 0) return ""
    return git(this.dir, [
      "-c",
      "core.quotePath=false",
      "diff",
      "-U0",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      from,
      to,
      "--",
      ...paths.map((p) => `:(literal)${p}`),
    ])
  }

  // A worktree of `commit` holding the files radius reads. Reused while it still points at the
  // commit, so a resumed or repeated evaluation does not check out again.
  async snapshot(commit: string, dir: string): Promise<string> {
    if (existsSync(join(dir, ".git"))) {
      try {
        if ((await git(dir, ["rev-parse", "HEAD"])).trim() === commit)
          return dir
      } catch {
        // a broken worktree is made again below
      }
    }
    rmSync(dir, { recursive: true, force: true })
    await git(this.dir, ["worktree", "prune"])
    await this.fetchCommits([commit])
    await git(this.dir, [
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      dir,
      commit,
    ])
    await git(dir, [
      "sparse-checkout",
      "set",
      "--no-cone",
      ...SNAPSHOT_PATTERNS,
    ])
    await git(dir, ["checkout", "-q", commit])
    return dir
  }
}
