// Replays the dependency upgrades of a git repository through radius, and compares each verdict
// with what the history says happened next. The one number that matters is a "quiet" on an
// upgrade the project had to adapt to.
//
//   node scripts/backtest.ts <repo> --since 2025-09-01 [--max 40] [--out results.jsonl]
//
// The oracle, per upgrade of package P in commit C:
//   adapted    C also changed source files that import P
//   follow-up  a later commit within 14 days changed files importing P and names P or a revert
// Both over-approximate a break (a commit can touch a file for another reason), so every quiet
// they flag is read by hand.

import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import { join, posix } from "node:path"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"

import semver from "semver"

import { run } from "../src/run.ts"
import { createCtx } from "../src/context.ts"
import type { Options } from "../src/options.ts"
import { matchNotes } from "../src/notes/match.ts"
import type { PackageBrief } from "../src/model.ts"
import { collectNotes } from "../src/notes/collect.ts"
import { defaultCacheDir } from "../src/infra/cache.ts"
import { npmLock } from "../src/inventory/lockfiles/npm.ts"
import { getPackument } from "../src/registry/packument.ts"
import { pnpmLock } from "../src/inventory/lockfiles/pnpm.ts"
import { yarnLock } from "../src/inventory/lockfiles/yarn.ts"
import { loadRegistryConfig } from "../src/registry/npmrc.ts"
import { selectCandidate } from "../src/registry/candidates.ts"
import type { LockReader } from "../src/inventory/lockfiles/types.ts"
import { SKIP_DIRS, toManifest } from "../src/inventory/manifests.ts"

const exec = promisify(execFile)

const LOCKFILES: [string, (t: string) => LockReader | undefined][] = [
  ["pnpm-lock.yaml", pnpmLock],
  ["package-lock.json", npmLock],
  ["yarn.lock", yarnLock],
]
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/
const SNAPSHOT =
  /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|\.npmrc|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss)$/

export interface Bump {
  name: string
  from: string
  to: string
}

export interface Row {
  repo: string
  commit: string
  date: string
  subject: string
  pkg: string
  from: string
  to: string
  bump: string
  verdict: string
  reasons: string[]
  surface: string
  touched: number
  notes: string
  direct: number
  possibly: number
  adapted: string[]
  followUps: string[]
  // note entries that match only when example-code demotion is off: what the 25% threshold silenced
  demoted: string[]
  error?: string
}

interface Commit {
  sha: string
  parent: string
  date: string
  subject: string
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    maxBuffer: 512 * 1024 * 1024,
  })
  return stdout
}

async function show(
  repo: string,
  sha: string,
  path: string
): Promise<string | undefined> {
  try {
    return await git(repo, ["show", `${sha}:${path}`])
  } catch {
    return undefined
  }
}

async function manifestsAt(
  repo: string,
  sha: string
): Promise<{ dir: string; json: Record<string, unknown> }[]> {
  const files = (await git(repo, ["ls-tree", "-r", "--name-only", sha]))
    .split("\n")
    .filter(
      (f) =>
        (f === "package.json" || f.endsWith("/package.json")) &&
        !f.split("/").some((s) => SKIP_DIRS.has(s))
    )
  const out: { dir: string; json: Record<string, unknown> }[] = []
  for (const f of files) {
    const text = await show(repo, sha, f)
    if (!text) continue
    try {
      out.push({
        dir: posix.dirname(f),
        json: JSON.parse(text) as Record<string, unknown>,
      })
    } catch {
      // a broken manifest in history is skipped, like radius would
    }
  }
  return out
}

// Direct dependencies whose locked version moved up between the parent and the commit.
export async function bumpsIn(
  repo: string,
  lockName: string,
  c: Commit
): Promise<Bump[]> {
  const reader = LOCKFILES.find(([n]) => n === lockName)![1]
  const [lp, lc] = await Promise.all([
    show(repo, c.parent, lockName),
    show(repo, c.sha, lockName),
  ])
  if (!lp || !lc) return []
  const before = reader(lp)
  const after = reader(lc)
  if (!before || !after) return []
  const [mp, mc] = await Promise.all([
    manifestsAt(repo, c.parent),
    manifestsAt(repo, c.sha),
  ])
  const found = new Map<string, Bump>()
  for (const m of mp) {
    const manifest = toManifest(join("/", m.dir, "package.json"), m.json)
    const next = mc.find((x) => x.dir === m.dir)
    const nextManifest = next
      ? toManifest(join("/", next.dir, "package.json"), next.json)
      : undefined
    for (const d of manifest.deps) {
      if (
        !["range", "tag", "alias", "catalog"].includes(d.specKind) ||
        d.field === "peerDependencies"
      )
        continue
      const specAfter =
        nextManifest?.deps.find((x) => x.key === d.key && x.field === d.field)
          ?.spec ?? d.spec
      const v1 = before.lookup(m.dir, d.key, d.spec)
      const v2 = after.lookup(m.dir, d.key, specAfter)
      if (!v1 || !v2 || v1.name !== v2.name) continue
      if (
        !semver.valid(v1.version) ||
        !semver.valid(v2.version) ||
        !semver.gt(v2.version, v1.version)
      )
        continue
      found.set(`${v1.name}@${v1.version}->${v2.version}`, {
        name: v1.name,
        from: v1.version,
        to: v2.version,
      })
    }
  }
  return [...found.values()]
}

function importsPkg(text: string, pkg: string): boolean {
  const n = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  return new RegExp(
    `(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)["']${n}(?:/[^"']*)?["']`
  ).test(text)
}

async function changedSources(
  repo: string,
  from: string,
  to: string
): Promise<string[]> {
  return (await git(repo, ["diff", "--name-only", from, to]))
    .split("\n")
    .filter((f) => SOURCE.test(f) && !f.includes("node_modules/"))
}

async function filesImporting(
  repo: string,
  sha: string,
  fallback: string,
  files: string[],
  pkg: string
): Promise<string[]> {
  const hits: string[] = []
  for (const f of files) {
    const text = (await show(repo, sha, f)) ?? (await show(repo, fallback, f))
    if (text && importsPkg(text, pkg)) hits.push(f)
  }
  return hits
}

// What radius reads, with content: manifests, lockfiles, sources, styles, configs. Every other file
// exists but is empty, because radius only needs to know an asset import points at a real file:
// leaving `import en from "../messages/en.json"` dangling would read as a blind spot that no real
// checkout has.
async function snapshot(repo: string, sha: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "radius-backtest-"))
  mkdirSync(join(dir, ".git"))
  const all = (await git(repo, ["ls-tree", "-r", "--name-only", sha]))
    .split("\n")
    .filter((f) => f && !f.split("/").some((s) => s === "node_modules"))
  const files = all.filter((f) => SNAPSHOT.test(f))
  for (const f of all) {
    if (SNAPSHOT.test(f)) continue
    mkdirSync(join(dir, posix.dirname(f)), { recursive: true })
    writeFileSync(join(dir, f), "")
  }
  const tar = `${dir}.tar`
  for (let i = 0; i < files.length; i += 400) {
    await exec(
      "git",
      [
        "-C",
        repo,
        "archive",
        "--format=tar",
        "-o",
        tar,
        sha,
        "--",
        ...files.slice(i, i + 400),
      ],
      {
        maxBuffer: 64 * 1024 * 1024,
      }
    )
    await exec("tar", ["-xf", tar, "-C", dir])
  }
  rmSync(tar, { force: true })
  return dir
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: "string", default: "2025-09-01" },
      max: { type: "string", default: "40" },
      out: { type: "string" },
      "cache-dir": { type: "string" },
      "no-surface": { type: "boolean" },
    },
  })
  const repo = positionals[0]
  if (!repo)
    throw new Error(
      "usage: node scripts/backtest.ts <repo> [--since date] [--max n] [--out file]"
    )
  const head = (await git(repo, ["ls-tree", "--name-only", "HEAD"])).split("\n")
  const lock = LOCKFILES.map(([n]) => n).find((n) => head.includes(n))
  if (!lock) throw new Error(`no supported lockfile at the root of ${repo}`)

  const log = (
    await git(repo, [
      "log",
      "--first-parent",
      `--since=${values.since}`,
      "--format=%H%x09%P%x09%cI%x09%s",
      "--",
      lock,
    ])
  )
    .split("\n")
    .filter(Boolean)
    .map((l): Commit => {
      const [sha, parents, date, ...subject] = l.split("\t")
      return {
        sha: sha!,
        parent: parents!.split(" ")[0]!,
        date: date!,
        subject: subject.join("\t"),
      }
    })
    .reverse()
  const later = (
    await git(repo, [
      "log",
      "--first-parent",
      `--since=${values.since}`,
      "--format=%H%x09%cI%x09%s",
    ])
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, date, ...subject] = l.split("\t")
      return { sha: sha!, date: date!, subject: subject.join("\t") }
    })
    .reverse()

  const max = Number(values.max)
  const cacheDir = values["cache-dir"] ?? defaultCacheDir(process.env)
  const rows: Row[] = []
  const repoName = posix.basename(repo.replace(/\/+$/, ""))
  let analysed = 0

  for (const c of log) {
    if (analysed >= max) break
    // the root commit has nothing to upgrade from
    if (!c.parent) continue
    const bumps = await bumpsIn(repo, lock, c)
    if (bumps.length === 0) continue
    analysed++
    process.stderr.write(
      `${repoName} ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} ${bumps.length} bumps: ${c.subject.slice(0, 60)}\n`
    )

    const changed = await changedSources(repo, c.parent, c.sha)
    const idx = later.findIndex((x) => x.sha === c.sha)
    const window = later
      .slice(idx + 1, idx + 11)
      .filter((x) => Date.parse(x.date) - Date.parse(c.date) < 14 * 86_400_000)

    const dir = await snapshot(repo, c.parent)
    const opts: Options = {
      root: dir,
      specs: bumps.map((b) => `${b.name}@${b.to}`),
      format: "json",
      offline: false,
      minAgeMs: 0,
      latest: false,
      notes: true,
      surface: !values["no-surface"],
      prod: false,
      concurrency: 8,
      cacheDir,
      verbose: false,
      now: Date.parse(c.date),
      color: false,
    }
    let briefs: PackageBrief[] = []
    let error: string | undefined
    const ctx = createCtx(opts)
    try {
      briefs = (await run(opts, ctx)).packages
    } catch (e) {
      error = String(e).slice(0, 300)
    }
    const cfg = loadRegistryConfig(dir, process.env)
    rmSync(dir, { recursive: true, force: true })

    for (const b of bumps) {
      const brief = briefs.find((p) => p.pkg === b.name && p.to === b.to)
      const adapted = await filesImporting(
        repo,
        c.sha,
        c.parent,
        changed,
        b.name
      )
      const followUps: string[] = []
      for (const w of window) {
        const short = b.name.split("/").pop()!
        if (
          !new RegExp(
            `\\b${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b|revert`,
            "i"
          ).test(w.subject)
        )
          continue
        const files = await changedSources(repo, `${w.sha}~1`, w.sha).catch(
          () => []
        )
        if (
          (await filesImporting(repo, w.sha, `${w.sha}~1`, files, b.name))
            .length > 0
        )
          followUps.push(`${w.sha.slice(0, 8)} ${w.subject.slice(0, 80)}`)
      }
      const demoted: string[] = []
      if (brief && brief.notes.total > 0) {
        const pack = await getPackument(ctx, cfg, b.name)
        const choice = pack.ok
          ? selectCandidate(pack.packument, b.from, {
              now: opts.now,
              minAgeMs: 0,
              ageExcluded: () => true,
              latest: false,
              explicit: b.to,
            })
          : undefined
        if (pack.ok && choice?.kind === "candidate") {
          // every fetch below is already in the cache from the run above
          const notes = await collectNotes(
            ctx,
            cfg,
            pack.packument,
            choice.candidate
          )
          const on = matchNotes(
            notes.entries,
            brief.usage.strongNames,
            brief.usage.weakNames
          )
          const off = matchNotes(
            notes.entries,
            brief.usage.strongNames,
            brief.usage.weakNames,
            { demoteShare: Infinity }
          )
          const kept = new Set(on.matched.map((m) => m.entry.id))
          for (const m of off.matched)
            if (!kept.has(m.entry.id))
              demoted.push(
                `${m.entry.version} ${m.entry.title.slice(0, 90)} [${m.hits.map((h) => h.name).join(",")}]`
              )
        }
      }
      rows.push({
        repo: repoName,
        commit: c.sha.slice(0, 8),
        date: c.date.slice(0, 10),
        subject: c.subject.slice(0, 100),
        pkg: b.name,
        from: b.from,
        to: b.to,
        bump:
          brief?.bump ??
          (semver.major(b.from) !== semver.major(b.to) ? "major" : "?"),
        verdict: brief?.verdict ?? "not-analysed",
        reasons: brief?.reasons.map((r) => r.code) ?? [],
        surface: brief
          ? `${brief.surface.status}${brief.surface.status === "computed" ? ` ${brief.surface.changes}` : ""}`
          : "",
        touched: brief?.surface.touched.length ?? 0,
        notes: brief?.notes.coverage ?? "",
        direct: brief?.notes.matched.filter((m) => m.direct).length ?? 0,
        possibly: brief?.notes.matched.filter((m) => !m.direct).length ?? 0,
        adapted,
        followUps,
        demoted,
        ...(error ? { error } : !brief ? { error: "no brief" } : {}),
      })
    }
    if (values.out)
      writeFileSync(
        values.out,
        `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
      )
  }

  const quiet = rows.filter((r) => r.verdict === "quiet")
  const suspects = quiet.filter(
    (r) => r.adapted.length > 0 || r.followUps.length > 0
  )
  const byVerdict = Object.fromEntries(
    ["quiet", "review", "blocked", "not-analysed"].map((v) => [
      v,
      rows.filter((r) => r.verdict === v).length,
    ])
  )
  process.stdout.write(
    `${JSON.stringify({ repo: repoName, commits: analysed, upgrades: rows.length, byVerdict, adaptedUpgrades: rows.filter((r) => r.adapted.length > 0 || r.followUps.length > 0).length, wrongQuietSuspects: suspects.length }, null, 2)}\n`
  )
  for (const s of suspects)
    process.stdout.write(
      `SUSPECT ${s.commit} ${s.pkg} ${s.from} -> ${s.to}: adapted ${s.adapted.join(", ")} ${s.followUps.join(" | ")}\n`
    )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
    )
    process.exitCode = 1
  })
}
