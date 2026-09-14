// Measures the implementation facts on the behaviour change benchmark, before they feed any verdict.
// For each case: download both versions from the registry (through the normal cache), list the
// exports whose code changed, and ask three questions.
//
//   noise   how many of the package's exports changed inside
//   usage   are the exports the project uses among them
//   notes   does a name the change's note mentions (`setItem`) sit in the changed code of an export
//           the project uses, and how many other notes of the release the same rule pulls in
//
// A note is linked by one of three rules, from strict to loose:
//
//   unit    it names a unit that changed under a used export
//   near    it names a changed unit, or a function or member a changed unit calls directly
//   reach   it names anything the code of a used export that changed can reach
//
//   node scripts/implementation-spike.ts [--json] [--case <id>]

import { parseArgs } from "node:util"
import { performance } from "node:perf_hooks"

import semver from "semver"

import { createCtx } from "../src/context.ts"
import type { Options } from "../src/options.ts"
import { scanUsage } from "../src/usage/scan.ts"
import { splitEntries } from "../src/notes/entries.ts"
import { defaultCacheDir } from "../src/infra/cache.ts"
import { getPackument } from "../src/registry/packument.ts"
import { getTarballFiles } from "../src/registry/tarball.ts"
import { loadRegistryConfig } from "../src/registry/npmrc.ts"
import { buildInventory } from "../src/inventory/installed.ts"
import { listProjectFiles } from "../src/inventory/manifests.ts"
import type { CanonPath, NoteEntry, RawRef } from "../src/model.ts"
import { effectiveChain, entryPrefix } from "../src/symbol-path.ts"
import { createProject, pkgJson } from "../tests/helpers/tmp-project.ts"
import {
  type BenchmarkCase,
  CASES_DIR,
  describesChange,
  loadCases,
  notesOf,
  readTree,
} from "../tests/benchmark/harness.ts"
import {
  buildImplementationFacts,
  diffImplementations,
  type Flavor,
  flavorFor,
  type ImplementationFacts,
  reach,
  shortName,
} from "../src/facts/implementation/index.ts"

const { values } = parseArgs({
  options: { json: { type: "boolean" }, case: { type: "string" } },
})

const RULES = ["unit", "near", "reach"] as const
type Rule = (typeof RULES)[number]

interface Row {
  id: string
  upgrade: string
  bump: "major" | "minor" | "patch"
  flavor?: Flavor
  error?: string
  ms?: number
  units?: number
  flags?: string[]
  exports?: number
  changed?: number
  used?: CanonPath[]
  usedChanged?: CanonPath[]
  changedUnits?: string[]
  // names from the change's note found anywhere in the package, with the strictest rule they meet
  names?: { name: string; rule?: Rule }[]
  // per rule: is the change's note linked, and how many other entries are
  links?: Record<Rule, { change: boolean; others: number }>
  entries?: number
}

const ctx = createCtx({
  root: process.cwd(),
  specs: [],
  format: "json",
  offline: false,
  minAgeMs: undefined,
  latest: false,
  notes: true,
  surface: true,
  prod: false,
  concurrency: 8,
  cacheDir: defaultCacheDir(process.env),
  verbose: false,
  now: Date.now(),
  color: false,
} satisfies Options)
const cfg = loadRegistryConfig(process.cwd(), process.env)

// Words that read as code: `inCode`, camelCase, snake_case, a scope such as `**throttle:**` or
// `fix(storage):`. Plain English words are left out, since a package often has a unit named `state`.
function codeNames(e: NoteEntry): string[] {
  const out = new Set<string>()
  for (const r of e.regions)
    if (r.kind === "inline-code" || r.kind === "code-block")
      for (const m of r.text.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0])
  for (const t of [e.title, ...e.regions.map((r) => r.text)]) {
    for (const m of t.matchAll(/[A-Za-z_$][\w$]*/g))
      if (/[a-z][A-Z]|[_$]|\d/.test(m[0]) || /^[A-Z][a-z]+[A-Z]/.test(m[0]))
        out.add(m[0])
    for (const m of t.matchAll(/\*\*([\w$]+):\*\*|\w+\(([\w$-]+)\)!?:/g))
      out.add((m[1] ?? m[2])!)
  }
  return [...out].filter((w) => w.length >= 3).sort()
}

// The exports a usage reference reaches, spelled as the facts spell them.
function usedPaths(
  pkg: string,
  refs: RawRef[],
  facts: ImplementationFacts
): CanonPath[] {
  const out = new Set<CanonPath>()
  for (const r of refs) {
    const ref =
      r.binding.kind === "derived" && r.origin
        ? {
            ...r,
            binding: r.origin.binding,
            entry: r.origin.entry,
            chain: [...r.origin.chain, ...r.chain],
            callSelf: r.origin.callSelf,
          }
        : r
    if (ref.binding.kind === "derived") continue
    const prefix = entryPrefix(pkg, ref.entry)
    const { segs, startsCalled } = effectiveChain(ref)
    const candidates: string[] = []
    const [a, b] = segs
    if (a && !startsCalled) {
      candidates.push(`${prefix}:${a.name}`)
      if (b)
        candidates.push(
          `${prefix}:${a.name}#${b.name}`,
          `${prefix}:${a.name}.${b.name}`
        )
    }
    if (a && startsCalled) candidates.push(`${prefix}:#${a.name}`)
    // ESM `export default lib` with `lib.get()`
    if (a && ref.binding.kind === "default")
      candidates.push(
        `${prefix}:default.${a.name}`,
        `${prefix}:default#${a.name}`
      )
    const found = candidates.filter((c) => facts.exports[c])
    // the module itself, when the reference names nothing more precise
    if (found.length === 0)
      found.push(
        ...[`${prefix}:`, `${prefix}:default`].filter((c) => facts.exports[c])
      )
    for (const c of found) out.add(c)
  }
  return [...out].sort()
}

async function versionsOf(c: BenchmarkCase) {
  const pack = await getPackument(ctx, cfg, c.package)
  if (!pack.ok) throw new Error(`packument: ${pack.reason}`)
  const a = pack.packument.versions[c.from]
  const b = pack.packument.versions[c.to]
  if (!a || !b) throw new Error("version not in the registry")
  return { a, b }
}

// timed without the facts cache, so the time is the computation's; tarballs come from the cache
async function factsOf(
  c: BenchmarkCase,
  pv: Awaited<ReturnType<typeof versionsOf>>["a"],
  flavor: Flavor
): Promise<{ facts: ImplementationFacts; ms: number }> {
  const tb = await getTarballFiles(ctx, cfg, pv, "runtime")
  if (!tb.ok) throw new Error(`tarball: ${tb.reason}`)
  const t0 = performance.now()
  const r = buildImplementationFacts(
    c.package,
    pv.version,
    tb.integrity,
    tb.files,
    flavor
  )
  const ms = performance.now() - t0
  if (!r.ok) throw new Error(`facts: ${r.reason} ${r.detail ?? ""}`)
  return { facts: r.facts, ms }
}

async function usageOf(c: BenchmarkCase): Promise<RawRef[]> {
  const project = createProject({
    files: {
      "package.json": pkgJson({
        name: "spike-project",
        private: true,
        dependencies: { [c.package]: `^${c.from}` },
      }),
      [`node_modules/${c.package}/package.json`]: JSON.stringify({
        name: c.package,
        version: c.from,
      }),
      ...readTree(`${CASES_DIR}/${c.id}/project`),
    },
  })
  try {
    const files = await listProjectFiles(project.root)
    const inventory = await buildInventory(project.root, { prod: false }, files)
    const usage = await scanUsage(undefined, project.root, files, inventory)
    return Object.values(usage.packages)
      .filter((p) => p.pkg === c.package)
      .flatMap((p) => p.refs)
  } finally {
    project.cleanup()
  }
}

async function measure(c: BenchmarkCase): Promise<Row> {
  const bump =
    semver.major(c.from) !== semver.major(c.to) ||
    (semver.major(c.from) === 0 && semver.minor(c.from) !== semver.minor(c.to))
      ? "major"
      : semver.minor(c.from) !== semver.minor(c.to)
        ? "minor"
        : "patch"
  const row: Row = { id: c.id, upgrade: `${c.from} -> ${c.to}`, bump }
  try {
    const { a: pvA, b: pvB } = await versionsOf(c)
    const flavor = flavorFor(
      pvA as unknown as Record<string, unknown>,
      pvB as unknown as Record<string, unknown>
    )
    const a = await factsOf(c, pvA, flavor)
    const b = await factsOf(c, pvB, flavor)
    const diff = diffImplementations(a.facts, b.facts)
    Object.assign(row, {
      flavor,
      ms: Math.round(a.ms + b.ms),
      units: a.facts.units.length + b.facts.units.length,
      flags: diff.flags,
      exports: diff.changed.length + diff.unchanged,
      changed: diff.changed.length,
    })

    const used = usedPaths(c.package, await usageOf(c), a.facts)
    const changedBy = new Map(diff.changed.map((ch) => [ch.path, ch.units]))
    const usedChanged = used.filter((p) => changedBy.has(p))
    const changedUnits = [
      ...new Set(usedChanged.flatMap((p) => changedBy.get(p)!)),
    ].sort()
    Object.assign(row, { used, usedChanged, changedUnits })

    // the names each rule accepts, from both versions
    const accepted: Record<Rule, Set<string>> = {
      unit: new Set(changedUnits.map(shortName)),
      near: new Set(changedUnits.map(shortName)),
      reach: new Set(),
    }
    const everywhere = new Set<string>()
    for (const f of [a.facts, b.facts]) {
      for (const u of f.units) {
        everywhere.add(shortName(u.name))
        for (const m of u.members) everywhere.add(m)
        if (!changedUnits.includes(u.name)) continue
        for (const m of u.members) accepted.near.add(m)
        for (const callee of u.calls)
          accepted.near.add(shortName(f.units[callee]!.name))
      }
      for (const p of usedChanged)
        for (const i of reach(f, p)) {
          accepted.reach.add(shortName(f.units[i]!.name))
          for (const m of f.units[i]!.members) accepted.reach.add(m)
        }
    }
    for (const n of accepted.near) accepted.reach.add(n)

    const entries = Object.entries(notesOf(c, `${CASES_DIR}/${c.id}`))
      .flatMap(([v, body]) => splitEntries(v, body))
      .filter((e) => !e.noise)
    row.entries = entries.length
    const linked = (e: NoteEntry, rule: Rule) =>
      codeNames(e).some((n) => accepted[rule].has(n))
    const change = entries.filter((e) => describesChange(c, e))
    const others = entries.filter((e) => !describesChange(c, e))
    row.names = [...new Set(change.flatMap(codeNames))]
      .filter((n) => everywhere.has(n))
      .sort()
      .map((name) => ({ name, rule: RULES.find((r) => accepted[r].has(name)) }))
    row.links = Object.fromEntries(
      RULES.map((rule) => [
        rule,
        {
          change: change.some((e) => linked(e, rule)),
          others: others.filter((e) => linked(e, rule)).length,
        },
      ])
    ) as Row["links"]
  } catch (error) {
    row.error = (error instanceof Error ? error.message : String(error)).slice(
      0,
      120
    )
  }
  return row
}

const rows: Row[] = []
for (const c of loadCases()) {
  if (values.case && c.id !== values.case) continue
  process.stderr.write(`${c.id}\n`)
  rows.push(await measure(c))
}

if (values.json) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const pct = (n: number, d: number) =>
    d ? `${Math.round((n / d) * 100)}%` : "-"
  const width = Math.max(...rows.map((r) => r.id.length))
  const mark: Record<Rule, string> = { unit: "U", near: "N", reach: "R" }
  console.log(
    `${"case".padEnd(width)}  bump   ${"changed".padEnd(13)}  used  ${"note names".padEnd(34)}  link  others U/N/R  ms`
  )
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.id.padEnd(width)}  error: ${r.error}`)
      continue
    }
    const names = r
      .names!.map((n) => `${n.name}${n.rule ? `(${mark[n.rule]})` : ""}`)
      .join(" ")
    const link = RULES.find((rule) => r.links![rule].change)
    console.log(
      [
        r.id.padEnd(width),
        r.bump.padEnd(5),
        `${r.changed}/${r.exports} ${pct(r.changed!, r.exports!)}`.padEnd(13),
        `${r.usedChanged!.length}/${r.used!.length}`.padEnd(4),
        (names.length > 34 ? `${names.slice(0, 33)}~` : names).padEnd(34),
        (link ? mark[link] : "-").padEnd(4),
        `${RULES.map((rule) => r.links![rule].others).join("/")} of ${r.entries}`.padEnd(
          12
        ),
        String(r.ms),
      ].join("  ")
    )
  }

  const ok = rows.filter((r) => !r.error)
  const median = (xs: number[]) =>
    [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0
  const summary = (label: string, group: Row[]) => {
    if (group.length === 0) return
    const share = median(group.map((r) => r.changed! / (r.exports || 1)))
    const rules = RULES.map((rule) => {
      const change = group.filter((r) => r.links![rule].change).length
      const others = group.reduce((n, r) => n + r.links![rule].others, 0)
      return `${rule} ${change} change / ${others} other`
    }).join(", ")
    const entries = group.reduce((n, r) => n + r.entries!, 0)
    console.log(
      `${label.padEnd(8)} ${String(group.length).padStart(2)} cases, median ${pct(share, 1)} of exports changed; notes linked: ${rules} (of ${entries} entries)`
    )
  }
  console.log("")
  summary("all", ok)
  for (const bump of ["patch", "minor", "major"] as const)
    summary(
      bump,
      ok.filter((r) => r.bump === bump)
    )
  const withUse = ok.filter((r) => r.used!.length > 0)
  const noteNames = ok.filter((r) => r.names!.length > 0)
  const times = ok.map((r) => r.ms!)
  console.log(`
usage    ${withUse.length} cases where a used export was found; one changed inside in ${withUse.filter((r) => r.usedChanged!.length > 0).length}
names    ${noteNames.length} change notes name code in the package; met by unit ${noteNames.filter((r) => r.names!.some((n) => n.rule === "unit")).length}, near ${noteNames.filter((r) => r.names!.some((n) => n.rule === "unit" || n.rule === "near")).length}, reach ${noteNames.filter((r) => r.names!.some((n) => n.rule)).length}
time     median ${median(times)} ms, max ${Math.max(...times)} ms for both versions; ${rows.length - ok.length} failures
legend   used: changed/used exports; link: strictest rule linking the change's note (U unit, N near, R reach)`)
}
