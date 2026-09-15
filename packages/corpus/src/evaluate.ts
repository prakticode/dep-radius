import { join } from "node:path"
import { existsSync, readdirSync } from "node:fs"

import { createCtx, type Options, run, toolVersion } from "@dep-radius/core"

import type { SplitName } from "./labels.ts"
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
  // evaluate every case, not only those `check` supports
  all: boolean
  // radius's own cache: packuments, tarballs and notes are shared with every other radius run
  radiusCache: string
  log: (line: string) => void
}

// A locked case's results and brief live apart, so reading the working ones never shows them.
export function setDir(data: string, split: SplitName): string {
  return split === "locked" ? join(data, "locked") : data
}

export function resultsDir(data: string, split: SplitName = "working"): string {
  return join(setDir(data, split), "results")
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
    writeJson(join(setDir(o.data, c.split), "briefs", `${c.id}.json`), brief)
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

export function loadResults(
  data: string,
  split: SplitName = "working"
): CaseResult[] {
  const dir = resultsDir(data, split)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<CaseResult>(join(dir, f))!)
    .filter(Boolean)
}

// The cases a score counts: supported by `check` unless `all`, and still in `cases/`.
export function counted(cases: CaseManifest[], all: boolean): CaseManifest[] {
  return cases.filter((c) => all || c.labels.check === "supported")
}

export interface SetSummary {
  totals: Totals
  // the same, for the cases whose fix is in tests only, and for the others
  testsOnly: Totals
  source: Totals
}

export interface EvaluateSummary {
  evaluated: number
  skipped: number
  // cases left out: not checked yet, or weak, reformat or error
  excluded: Record<string, number>
  stopped?: string
  working: SetSummary
  locked: SetSummary
  // per case, working set only
  results: CaseResult[]
  cases: CaseManifest[]
}

function summarise(results: CaseResult[], cases: CaseManifest[]): SetSummary {
  const tests = new Set(
    cases.filter((c) => c.labels.testsOnly).map((c) => c.id)
  )
  return {
    totals: totals(results),
    testsOnly: totals(results.filter((r) => tests.has(r.id))),
    source: totals(results.filter((r) => !tests.has(r.id))),
  }
}

export async function evaluate(
  gh: GitHub,
  o: EvaluateOptions
): Promise<EvaluateSummary> {
  const all = loadCases(o.data)
  const chosen = counted(all, o.all)
  const excluded: Record<string, number> = {}
  for (const c of all)
    if (!chosen.includes(c)) {
      const k = c.labels.check ?? "not checked"
      excluded[k] = (excluded[k] ?? 0) + 1
    }
  const pending: CaseManifest[] = []
  let skipped = 0
  for (const c of chosen) {
    const done = readJson<CaseResult>(
      join(resultsDir(o.data, c.split), `${c.id}.json`)
    )
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
      o.log(
        c.split === "locked"
          ? `${c.id}: evaluating (locked)`
          : `${c.id}: evaluating ${c.packages.length} upgrades`
      )
      const r = await evaluateCase(o, c)
      writeJson(join(resultsDir(o.data, c.split), `${c.id}.json`), r)
      evaluated++
      if (c.split === "locked") {
        o.log(`${c.id}: ${r.error ? "error" : "done"} (locked)`)
        continue
      }
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

  const ids = (split: SplitName) =>
    new Set(chosen.filter((c) => c.split === split).map((c) => c.id))
  const working = ids("working")
  const locked = ids("locked")
  const workingResults = loadResults(o.data, "working").filter((r) =>
    working.has(r.id)
  )
  const lockedResults = loadResults(o.data, "locked").filter((r) =>
    locked.has(r.id)
  )
  const summary: EvaluateSummary = {
    evaluated,
    skipped,
    excluded,
    ...(stopped ? { stopped } : {}),
    working: summarise(workingResults, chosen),
    locked: summarise(lockedResults, chosen),
    results: workingResults,
    cases: chosen.filter((c) => c.split === "working"),
  }
  const generatedAt = new Date().toISOString()
  writeJson(join(o.data, "report.json"), {
    generatedAt,
    radius: toolVersion(),
    working: summary.working,
    locked: summary.locked,
    results: workingResults,
  })
  writeJson(join(o.data, "locked", "report.json"), {
    generatedAt,
    radius: toolVersion(),
    locked: summary.locked,
    results: lockedResults,
  })
  return summary
}

const pct = (a: number, b: number) =>
  b ? `${Math.round((a / b) * 100)}%` : "-"

// The five numbers of a set, on one row each: what the README defines.
export function renderNumbers(label: string, t: Totals): string[] {
  return [
    `${label}: ${t.cases} cases (${t.errors} errors, ${t.scoredCases} scored)`,
    `  found at the line   ${pct(t.foundCases, t.scoredCases)} (${t.foundCases} of ${t.scoredCases} cases)`,
    `  wrong quiet         ${pct(t.wrongQuietCases, t.scoredCases)} (${t.wrongQuietCases} of ${t.scoredCases} cases)`,
    `  median cannot tie   ${t.medianCannotTie} notes`,
    `  precision           ${pct(t.reportedHits, t.reportedLines)} of lines (${t.reportedHits} of ${t.reportedLines}), ${pct(t.matchedNotesHit, t.matchedNotes)} of matched notes (${t.matchedNotesHit} of ${t.matchedNotes})`,
    `  quiet rate          ${pct(t.quietPackages, t.analysedPackages)} (${t.quietPackages} of ${t.analysedPackages} analysed packages)`,
  ]
}

function renderSet(label: string, s: SetSummary): string[] {
  return [
    ...renderNumbers(label, s.totals),
    ...renderNumbers(`${label}, fix in source`, s.source),
    ...renderNumbers(`${label}, fix in tests only`, s.testsOnly),
  ]
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
  const excluded = Object.entries(s.excluded)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ")
  return [
    "working set, per case:",
    line(head),
    ...rows.map(line),
    "",
    ...renderSet("working", s.working),
    "",
    // never per case: the locked set only ever gives totals
    ...renderSet("locked", s.locked),
    "",
    `left out: ${excluded || "none"}`,
  ].join("\n")
}
