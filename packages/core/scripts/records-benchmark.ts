// Measures change records made by a model on the behaviour change benchmark. It runs the benchmark
// with the rules alone, asks the model about the entries of the missed cases that radius cannot
// place, writes the records to a directory, and runs the benchmark again with them.
//
// The model sees an entry's text and the package's APIs only. What a case expects (its lines, the
// words of its change, why it breaks) is read after the records exist, to score them.
//
//   node scripts/records-benchmark.ts --out <records dir> [--cache <dir>] [--max-calls 300]
//                                     [--agreement same|both] [--dry-run] [--json <file>]
//
// --agreement both keeps the subjects both runs name instead of requiring the same set.

import { join } from "node:path"
import { parseArgs } from "node:util"
import { writeFileSync } from "node:fs"

import semver from "semver"

import { createCtx } from "../src/context.ts"
import type { Options } from "../src/options.ts"
import type { HttpClient } from "../src/infra/http.ts"
import { splitEntries } from "../src/notes/entries.ts"
import { defaultCacheDir } from "../src/infra/cache.ts"
import { extractSurface } from "../src/surface/extract.ts"
import { getPackument } from "../src/registry/packument.ts"
import type { ChangeRecord } from "../src/records/record.ts"
import { loadRegistryConfig } from "../src/registry/npmrc.ts"
import type { NoteEntry, PackageBrief, Surface } from "../src/model.ts"
import {
  type Answer,
  candidatesFor,
  defaultBackend,
  extractRecords,
  promptFor,
  type Surfaces,
  wantsRecord,
  writeRecords,
} from "./records-ai.ts"
import {
  type BenchmarkCase,
  type CaseResult,
  CASES_DIR,
  describesChange,
  loadCases,
  notesOf,
  registryFor,
  runCase,
  totals,
} from "../tests/benchmark/harness.ts"

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    cache: { type: "string" },
    "max-calls": { type: "string" },
    "dry-run": { type: "boolean" },
    agreement: { type: "string" },
    json: { type: "string" },
  },
})
if (!values.out) throw new Error("--out <records dir> is required")
const recordsDir = values.out
const cacheDir =
  values.cache ?? join(defaultCacheDir(process.env), "records-ai")
let budget = Number(values["max-calls"] ?? 300)

interface Run {
  result: CaseResult
  brief: PackageBrief
}

async function runAll(
  cases: BenchmarkCase[],
  dir?: string
): Promise<Map<string, Run>> {
  const out = new Map<string, Run>()
  for (const c of cases) {
    let brief: PackageBrief | undefined
    const result = await runCase(c, CASES_DIR, {
      onBrief: (b) => (brief = b),
      ...(dir ? { recordsDir: dir } : {}),
    })
    out.set(c.id, { result, brief: brief! })
  }
  return out
}

// The entries as a run splits them, in the order of their versions.
function entriesOf(c: BenchmarkCase): NoteEntry[] {
  return Object.entries(notesOf(c, join(CASES_DIR, c.id)))
    .sort(([a], [b]) => semver.compare(a, b))
    .flatMap(([version, body]) => splitEntries(version, body))
}

function ctxFor(http?: HttpClient) {
  const opts: Options = {
    root: process.cwd(),
    specs: [],
    format: "json",
    offline: false,
    minAgeMs: 0,
    latest: false,
    notes: true,
    surface: true,
    prod: false,
    concurrency: 8,
    cacheDir: join(cacheDir, "registry", http ? "fake" : "npm"),
    verbose: false,
    now: Date.now(),
    color: false,
  }
  return createCtx(opts, http)
}

// The types a case ships, or the package's published types when it ships none, or those of
// @types/<name> for the same major when the package has none of its own.
async function surfacesOf(c: BenchmarkCase): Promise<Surfaces | string> {
  const { registry, withTypes } = registryFor(c)
  const ctx = withTypes ? ctxFor(registry) : ctxFor()
  const cfg = loadRegistryConfig(process.cwd(), {})
  const pack = await getPackument(ctx, cfg, c.package)
  if (!pack.ok) return `registry: ${pack.reason}`
  const typesName = `@types/${c.package.replace(/^@/, "").replace("/", "__")}`
  const typesPack = withTypes
    ? undefined
    : await getPackument(ctx, cfg, typesName)
  const one = async (version: string): Promise<Surface | string> => {
    const own = await extractSurface(ctx, cfg, pack.packument, version)
    if (own.ok) return own.surface
    if (own.reason !== "no-types" || !typesPack?.ok) return own.reason
    const versions = Object.keys(typesPack.packument.versions)
    const match =
      semver.maxSatisfying(
        versions,
        `~${semver.major(version)}.${semver.minor(version)}.0`
      ) ?? semver.maxSatisfying(versions, `^${semver.major(version)}.0.0`)
    if (!match) return "no-types"
    const typed = await extractSurface(ctx, cfg, typesPack.packument, match)
    return typed.ok
      ? renamed(typed.surface, typesName, c.package)
      : typed.reason
  }
  const [a, b] = await Promise.all([one(c.from), one(c.to)])
  if (typeof a === "string" || typeof b === "string")
    return `no type surface (${typeof a === "string" ? a : "ok"}, ${typeof b === "string" ? b : "ok"})`
  return { from: a, to: b }
}

// @types/lib's paths as lib's: what the code imports
function renamed(surface: Surface, from: string, to: string): Surface {
  const rename = (path: string) =>
    path.startsWith(from) ? `${to}${path.slice(from.length)}` : path
  return {
    ...surface,
    pkg: to,
    symbols: Object.fromEntries(
      Object.entries(surface.symbols).map(([path, sym]) => [
        rename(path),
        { ...sym, path: rename(path) },
      ])
    ),
  }
}

const cases = loadCases()
console.error("rules only...")
const before = await runAll(cases)
const missed = cases.filter((c) => before.get(c.id)!.result.status === "missed")

// the unplaced changes and breaks of the missed cases first, then their other changes nobody matched
const plan: { c: BenchmarkCase; entry: NoteEntry; unplaced: boolean }[] = []
for (const c of missed) {
  const notes = before.get(c.id)!.brief.notes
  const unplaced = new Set(
    [...notes.unattributedChanges, ...notes.unattributedBreaking].map(
      (e) => e.id
    )
  )
  const matched = new Set(notes.matched.map((m) => m.entry.id))
  for (const entry of entriesOf(c).filter(wantsRecord))
    if (!matched.has(entry.id))
      plan.push({ c, entry, unplaced: unplaced.has(entry.id) })
}
plan.sort((a, b) => Number(b.unplaced) - Number(a.unplaced))

const surfaces = new Map<string, Surfaces | string>()
for (const c of missed) surfaces.set(c.id, await surfacesOf(c))
const planned = plan.filter((p) => typeof surfaces.get(p.c.id) !== "string")

console.error(
  `${missed.length} missed cases, ${plan.length} entries to read (${plan.filter((p) => p.unplaced).length} unplaced), ${planned.length} with a type surface, budget ${budget} calls`
)
for (const c of missed) {
  const s = surfaces.get(c.id)!
  console.error(
    `  ${c.id}: ${typeof s === "string" ? s : `${Object.keys(s.from.symbols).length}/${Object.keys(s.to.symbols).length} symbols`}, ${planned.filter((p) => p.c.id === c.id).length} entries`
  )
}
if (values["dry-run"]) {
  if (values.json)
    writeFileSync(
      values.json,
      planned
        .map(
          (p) =>
            `### ${p.c.id}\n${promptFor(p.entry, candidatesFor(p.entry, surfaces.get(p.c.id) as Surfaces))}`
        )
        .join("\n\n")
    )
  process.exit(0)
}

const backend = defaultBackend(process.env)
// the unplaced entries first, then the rest, taking turns between cases so the budget reaches all
const turns = (list: typeof planned) => {
  const queues = missed.map((c) => list.filter((p) => p.c.id === c.id))
  const out: typeof planned = []
  for (let i = 0; queues.some((q) => i < q.length); i++)
    for (const q of queues) if (q[i]) out.push(q[i]!)
  return out
}
const chosen = [
  ...turns(planned.filter((p) => p.unplaced)),
  ...turns(planned.filter((p) => !p.unplaced)),
].slice(0, Math.floor(budget / 2))
console.error(`asking about ${chosen.length} entries`)
const outcomes: {
  c: BenchmarkCase
  entry: NoteEntry
  unplaced: boolean
  runs: Answer[]
  agreed: boolean
  record?: ChangeRecord
}[] = []
for (const c of missed) {
  const s = surfaces.get(c.id)
  const mine = chosen.filter((p) => p.c.id === c.id)
  if (!s || typeof s === "string" || mine.length === 0) continue
  const { outcomes: got, freshCalls } = await extractRecords(
    c.package,
    mine.map((p) => p.entry),
    s,
    {
      backend: backend.call,
      cacheDir,
      maxCalls: budget,
      agreement: values.agreement === "both" ? "both" : "same",
      log: (line) => console.error(line),
    }
  )
  budget -= freshCalls
  console.error(`  ${c.id}: ${freshCalls} calls, ${budget} left`)
  for (const [i, o] of got.entries())
    outcomes.push({ ...o, c, unplaced: mine[i]!.unplaced })
}

const byPackage = new Map<string, Map<string, ChangeRecord>>()
for (const o of outcomes) {
  if (!o.record) continue
  const m = byPackage.get(o.c.package) ?? new Map<string, ChangeRecord>()
  m.set(JSON.stringify(o.record), o.record)
  byPackage.set(o.c.package, m)
}
for (const [pkg, records] of byPackage)
  await writeRecords(recordsDir, pkg, [...records.values()])

console.error("with records...")
const after = await runAll(cases, recordsDir)

// ---------------------------------------------------------------- report

const pct = (x: number) => `${Math.round(x * 100)}%`
const t0 = totals([...before.values()].map((r) => r.result))
const t1 = totals([...after.values()].map((r) => r.result))
const asked = outcomes.filter((o) => o.runs.length > 0)
const agreed = asked.filter((o) => o.agreed)
const withSubjects = outcomes.filter(
  (o) => (o.record?.subjects.length ?? 0) > 0
)

console.log(`backend ${backend.name}, ${asked.length} entries asked twice`)
console.log(
  `stability: ${agreed.length} of ${asked.length} entries got the same subjects twice (${pct(asked.length ? agreed.length / asked.length : 0)})`
)
console.log(`records with subjects: ${withSubjects.length}`)
console.log(`\n              caught   precision  quiet`)
console.log(
  `rules only    ${t0.caught}/${t0.cases}    ${pct(t0.precision).padEnd(9)}  ${t0.quiet}`
)
console.log(
  `with records  ${t1.caught}/${t1.cases}    ${pct(t1.precision).padEnd(9)}  ${t1.quiet}`
)

const quiet = cases.filter((c) => after.get(c.id)!.result.verdict === "quiet")
if (quiet.length > 0)
  console.log(
    `\n!!! WRONG QUIET WITH RECORDS: ${quiet.map((c) => c.id).join(", ")}`
  )

console.log("\ncases that changed:")
const moved: unknown[] = []
for (const c of cases) {
  const a = before.get(c.id)!
  const b = after.get(c.id)!
  const key = (r: Run) =>
    `${r.result.status} ${r.result.verdict} ${r.result.sitesFound}/${r.result.sitesExpected} other ${r.result.otherMatches}`
  if (key(a) !== key(b)) console.log(`  ${c.id}: ${key(a)}  ->  ${key(b)}`)
  const unplacedBefore = [
    ...a.brief.notes.unattributedChanges,
    ...a.brief.notes.unattributedBreaking,
  ]
  const matchedAfter = new Map(
    b.brief.notes.matched.map((m) => [m.entry.id, m])
  )
  const unplacedAfter = new Set(
    [
      ...b.brief.notes.unattributedChanges,
      ...b.brief.notes.unattributedBreaking,
    ].map((e) => e.id)
  )
  for (const e of unplacedBefore) {
    if (unplacedAfter.has(e.id)) continue
    const m = matchedAfter.get(e.id)
    moved.push({
      case: c.id,
      entry: e.title,
      to: m
        ? `placed on ${m.hits.map((h) => h.subject ?? h.name).join(", ")}`
        : "placed elsewhere",
      isTheChange: describesChange(c, e),
    })
  }
}
console.log('\nnotes that went from "cannot tie" to placed:')
for (const m of moved as {
  case: string
  entry: string
  to: string
  isTheChange: boolean
}[])
  console.log(
    `  ${m.case}${m.isTheChange ? " [the change]" : ""}: ${m.entry.slice(0, 80)}  ->  ${m.to}`
  )

console.log("\nrecords:")
for (const o of outcomes) {
  const runs = o.runs
    .map(
      (r) =>
        `${r.unsure ? "unsure " : ""}[${r.subjects.join(", ")}]${r.rejected.length ? ` rejected ${r.rejected.join(", ")}` : ""}`
    )
    .join(" | ")
  console.log(
    `  ${o.c.id}${describesChange(o.c, o.entry) ? " [the change]" : ""}: ${o.entry.title.slice(0, 70)}\n    ${runs || "not asked"} => ${o.record ? `[${o.record.subjects.join(", ")}]` : "no record"}`
  )
}

if (values.json)
  writeFileSync(
    values.json,
    JSON.stringify(
      {
        totals: { before: t0, after: t1 },
        stability: { asked: asked.length, agreed: agreed.length },
        quiet: quiet.map((c) => c.id),
        moved,
        outcomes: outcomes.map((o) => ({
          case: o.c.id,
          entry: o.entry.title,
          isTheChange: describesChange(o.c, o.entry),
          unplaced: o.unplaced,
          runs: o.runs,
          agreed: o.agreed,
          subjects: o.record?.subjects ?? null,
        })),
        results: cases.map((c) => ({
          before: before.get(c.id)!.result,
          after: after.get(c.id)!.result,
        })),
      },
      null,
      2
    )
  )
