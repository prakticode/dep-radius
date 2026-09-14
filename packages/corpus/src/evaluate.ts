import { join } from "node:path"
import { existsSync, readdirSync } from "node:fs"

import { createCtx, type Options, run, toolVersion } from "@dep-radius/core"

import { Repo, VERSION_FILE } from "./git.ts"
import { readJson, writeJson } from "./store.ts"
import { BudgetError, type GitHub } from "./github.ts"
import { type CaseManifest, loadCases } from "./case.ts"
import { type CaseResult, scorePackage, totals, type Totals } from "./score.ts"

export interface EvaluateOptions {
  data: string
  limit: number
  concurrency: number
  force: boolean
  // radius's own cache: packuments, tarballs and notes are shared with every other radius run
  radiusCache: string
  log: (line: string) => void
}

export function resultsDir(data: string): string {
  return join(data, "results")
}

export function snapshotDir(data: string, id: string): string {
  return join(data, "work", id)
}

const repoLocks = new Map<string, Promise<unknown>>()

// The upgraded snapshot of a case, checked out with what radius reads, and the base commit's
// version files ready for `--since`. Two cases of one repository take turns: git refuses two
// fetches or worktree changes on the same clone at once.
export async function prepareSnapshot(
  data: string,
  c: CaseManifest
): Promise<string> {
  const repo = new Repo(data, c.repo)
  const prepare = async () => {
    await repo.fetchCommits([c.base, c.upgraded])
    await repo.prefetch(c.base, (p) => VERSION_FILE.test(p))
    return repo.snapshot(c.upgraded, snapshotDir(data, c.id))
  }
  const turn = (repoLocks.get(repo.dir) ?? Promise.resolve()).then(
    prepare,
    prepare
  )
  repoLocks.set(repo.dir, turn)
  return turn
}

async function evaluateCase(
  o: EvaluateOptions,
  c: CaseManifest
): Promise<CaseResult> {
  const result: CaseResult = {
    id: c.id,
    repo: c.repo,
    pr: c.pr,
    evaluatedAt: new Date().toISOString(),
    packages: [],
  }
  try {
    const root = await prepareSnapshot(o.data, c)
    const opts: Options = {
      root,
      specs: c.packages.map((p) => p.name),
      since: c.base,
      format: "json",
      offline: false,
      minAgeMs: 0,
      latest: false,
      notes: true,
      surface: true,
      prod: false,
      concurrency: 8,
      cacheDir: o.radiusCache,
      verbose: false,
      now: Date.now(),
      color: false,
    }
    const brief = await run(opts, createCtx(opts))
    writeJson(join(o.data, "briefs", `${c.id}.json`), brief)
    result.packages = c.packages.map((p) => scorePackage(c, p, brief))
    // notes missing for want of budget would read as a real miss: the case is run again later
    const limited = brief.packages.some((p) =>
      p.notes.perVersion.some((v) => v.reason === "rate-limited")
    )
    if (limited) result.error = "GitHub rate limit hit while reading notes"
  } catch (e) {
    result.error = String(e instanceof Error ? e.message : e).slice(0, 500)
  }
  return result
}

export function loadResults(data: string): CaseResult[] {
  const dir = resultsDir(data)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<CaseResult>(join(dir, f))!)
    .filter(Boolean)
}

export interface EvaluateSummary {
  evaluated: number
  skipped: number
  stopped?: string
  totals: Totals
  results: CaseResult[]
}

export async function evaluate(
  gh: GitHub,
  o: EvaluateOptions
): Promise<EvaluateSummary> {
  const pending: CaseManifest[] = []
  let skipped = 0
  for (const c of loadCases(o.data)) {
    const done = readJson<CaseResult>(join(resultsDir(o.data), `${c.id}.json`))
    if (done && !done.error && !o.force) {
      skipped++
      continue
    }
    if (pending.length < o.limit) pending.push(c)
  }

  let evaluated = 0
  let stopped: string | undefined
  let next = 0
  const worker = async () => {
    while (!stopped && next < pending.length) {
      const c = pending[next++]!
      try {
        // radius reads release notes through the core REST budget
        await gh.ensure("core", { fresh: true })
      } catch (e) {
        if (!(e instanceof BudgetError)) throw e
        stopped = e.message
        return
      }
      o.log(`${c.id}: evaluating ${c.packages.length} upgrades`)
      const r = await evaluateCase(o, c)
      writeJson(join(resultsDir(o.data), `${c.id}.json`), r)
      evaluated++
      o.log(
        r.error
          ? `${c.id}: error: ${r.error.slice(0, 200)}`
          : `${c.id}: ${r.packages
              .filter((p) => p.expected > 0)
              .map(
                (p) =>
                  `${p.name} ${p.verdict}${p.found ? " found" : ""} (${p.matchedNotes} matched, ${p.cannotTie} cannot tie)`
              )
              .join("; ")}`
      )
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, o.concurrency) }, () => worker())
  )

  const results = loadResults(o.data)
  const sum = totals(results)
  writeJson(join(o.data, "report.json"), {
    generatedAt: new Date().toISOString(),
    radius: toolVersion(),
    totals: sum,
    results,
  })
  return {
    evaluated,
    skipped,
    ...(stopped ? { stopped } : {}),
    totals: sum,
    results,
  }
}

export function renderSummary(s: EvaluateSummary): string {
  const rows = s.results.flatMap((r) =>
    r.error
      ? [[r.id, "error", "", "", "", r.error.slice(0, 60)]]
      : r.packages
          .filter((p) => p.expected > 0)
          .map((p) => [
            r.id,
            `${p.name} ${p.from} -> ${p.to}`,
            p.verdict,
            p.found
              ? `yes (${p.foundBy.join("+")})`
              : p.sameFile
                ? "file"
                : "no",
            String(p.matchedNotes),
            String(p.cannotTie),
          ])
  )
  const head = ["case", "upgrade", "verdict", "found", "matched", "cannot tie"]
  const widths = head.map((h, i) =>
    Math.min(
      60,
      Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length))
    )
  )
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.slice(0, widths[i]).padEnd(widths[i]!))
      .join("  ")
      .trimEnd()
  const t = s.totals
  const pct = (a: number, b: number) =>
    b ? `${Math.round((a / b) * 100)}%` : "-"
  return [
    line(head),
    ...rows.map(line),
    "",
    `cases ${t.cases} (${t.errors} errors, ${t.scoredCases} with expected lines)`,
    `found ${t.foundCases} of ${t.scoredCases} cases (${pct(t.foundCases, t.scoredCases)}), ${t.foundPackages} of ${t.packages} packages (${pct(t.foundPackages, t.packages)})`,
    `wrong quiet ${t.wrongQuietCases} cases, ${t.wrongQuietPackages} packages; not analysed ${t.notAnalysedPackages} packages`,
    `median list length ${t.medianCannotTie} notes radius cannot tie, median matched notes ${t.medianMatchedNotes}`,
  ].join("\n")
}
