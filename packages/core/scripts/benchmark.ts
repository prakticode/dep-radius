// Runs the behaviour change benchmark and prints what radius links today: for each real release
// note that changed behaviour, whether radius tied it to the lines it lands on, and how many other
// notes a reader is shown next to it.
//
//   node scripts/benchmark.ts [--json]

import { parseArgs } from "node:util"

import {
  assertWellFormed,
  type CaseResult,
  loadCases,
  runCase,
  totals,
} from "../tests/benchmark/harness.ts"

const { values } = parseArgs({ options: { json: { type: "boolean" } } })

const results: CaseResult[] = []
for (const c of loadCases()) {
  assertWellFormed(c)
  results.push(await runCase(c))
}
const sum = totals(results)

if (values.json) {
  console.log(JSON.stringify({ totals: sum, results }, null, 2))
} else {
  const width = Math.max(...results.map((r) => r.id.length))
  console.log(`${"case".padEnd(width)}  status  verdict  sites  other notes`)
  for (const r of results)
    console.log(
      `${r.id.padEnd(width)}  ${r.status.padEnd(6)}  ${r.verdict.padEnd(7)}  ${`${r.sitesFound}/${r.sitesExpected}`.padEnd(5)}  ${r.otherMatches} of ${r.entries}`
    )
  const pct = (x: number) => `${Math.round(x * 100)}%`
  console.log(
    `\n${sum.caught} of ${sum.cases} caught (recall ${pct(sum.recall)}), precision ${pct(sum.precision)}, ${sum.quiet} called quiet`
  )
}
