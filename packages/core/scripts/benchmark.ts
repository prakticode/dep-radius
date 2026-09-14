// Runs the behaviour change benchmark and prints what radius links today: for each real release
// note that changed behaviour, whether radius tied it to the lines it lands on, and how many other
// notes a reader is shown next to it.
//
//   node scripts/benchmark.ts [--json] [--runtime]
//
// --runtime downloads each case's two versions from the npm registry (through the normal cache) and
// serves their JavaScript next to the case's files, so the code hints have code to read.

import { parseArgs } from "node:util"

import { createCtx } from "../src/context.ts"
import type { Options } from "../src/options.ts"
import { defaultCacheDir } from "../src/infra/cache.ts"
import { getPackument } from "../src/registry/packument.ts"
import { getTarballFiles } from "../src/registry/tarball.ts"
import { loadRegistryConfig } from "../src/registry/npmrc.ts"
import {
  assertWellFormed,
  type BenchmarkCase,
  type CaseResult,
  loadCases,
  runCase,
  type RuntimeFiles,
  totals,
} from "../tests/benchmark/harness.ts"

const { values } = parseArgs({
  options: { json: { type: "boolean" }, runtime: { type: "boolean" } },
})

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

async function runtimeOf(c: BenchmarkCase): Promise<RuntimeFiles> {
  const pack = await getPackument(ctx, cfg, c.package)
  if (!pack.ok) throw new Error(`${c.id}: packument: ${pack.reason}`)
  const out: RuntimeFiles = {}
  for (const version of [c.from, c.to]) {
    const pv = pack.packument.versions[version]
    if (!pv) throw new Error(`${c.id}: ${version} not in the registry`)
    const tb = await getTarballFiles(ctx, cfg, pv, "runtime")
    if (!tb.ok) throw new Error(`${c.id}: tarball: ${tb.reason}`)
    out[version] = Object.fromEntries(
      [...tb.files].map(([path, bytes]) => [path, bytes.toString("utf8")])
    )
  }
  return out
}

const started = Date.now()
const results: CaseResult[] = []
for (const c of loadCases()) {
  assertWellFormed(c)
  const runtime = values.runtime ? await runtimeOf(c) : undefined
  results.push(await runCase(c, undefined, runtime ? { runtime } : {}))
}
const sum = totals(results)
const seconds = (Date.now() - started) / 1000

if (values.json) {
  console.log(JSON.stringify({ totals: sum, results }, null, 2))
} else {
  const width = Math.max(...results.map((r) => r.id.length))
  console.log(
    `${"case".padEnd(width)}  status  verdict  sites  other notes  hints`
  )
  for (const r of results)
    console.log(
      `${r.id.padEnd(width)}  ${r.status.padEnd(6)}  ${r.verdict.padEnd(7)}  ${`${r.sitesFound}/${r.sitesExpected}`.padEnd(5)}  ${`${r.otherMatches} of ${r.entries}`.padEnd(11)}  ${r.hints === 0 ? "-" : `${r.hinted ? "hinted" : "not hinted"}, ${r.hints} (${r.falseHints} false)`}`
    )
  const pct = (x: number) => `${Math.round(x * 100)}%`
  console.log(
    `\n${sum.caught} of ${sum.cases} caught (recall ${pct(sum.recall)}), precision ${pct(sum.precision)}, ${sum.quiet} called quiet`
  )
  console.log(
    values.runtime
      ? `${sum.hinted} hinted (${sum.newlyHinted} not caught by name), ${sum.hints.total} hints, ${sum.hints.false} false, median ${sum.hints.median} and at most ${sum.hints.max} per case; ${seconds.toFixed(1)} s`
      : `hinted: no code read (pass --runtime); ${seconds.toFixed(1)} s`
  )
}
