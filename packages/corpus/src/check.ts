import { join } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"

import {
  buildInventory,
  listProjectFiles,
  scanUsage,
} from "@dep-radius/core/debug"

import { writeJson } from "./store.ts"
import { isTestFile } from "./labels.ts"
import { REFORMAT_SHARE } from "./reformat.ts"
import { prepareSnapshot } from "./evaluate.ts"
import { packageLines } from "./usage-lines.ts"
import { atTypesName, type Npm, typesSource } from "./npm.ts"
import {
  type CaseManifest,
  type CheckResult,
  loadCases,
  saveCase,
  type TypesSource,
} from "./case.ts"

export interface PackageUsageFacts {
  // every name the scan saw the code use from the package
  names: string[]
  // every place it did
  sites: { file: string; line: number }[]
  // `file:line` of object keys reaching the package's calls, at any depth, JSX attributes included
  options?: string[]
  // `file:line` where a type imported from the package is written
  types?: string[]
  // `file:line` of the imports, requires and re-exports of the package
  imports?: string[]
}

export interface Evidence {
  package: string
  // expected lines that are themselves a use of the package
  onSite: string[]
  // expected lines that are keys of an object the package receives
  options: string[]
  // expected lines writing a type imported from the package
  types: string[]
  // expected lines importing the package: an entry point moved or renamed
  imports: string[]
  // names used from the package that the fix's removed or written lines mention
  names: string[]
}

export interface Review {
  id: string
  url: string
  title: string
  packages: string[]
  expected: number
  result: CheckResult
  // nothing ties the fix to what the code uses from the upgraded packages: a person decides
  weak: boolean
  testsOnly: boolean
  expectedReformatShare: number
  evidence: Evidence[]
  error?: string
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A case is weak when no changed line is a use of an upgraded package, a key of an object handed to
// one, a type imported from one or an import of one, and no changed line mentions a name the code uses from one.
// Such a fix may still answer the upgrade (a changed return value handled further down), or be
// unrelated work pushed on the same branch: only reading tells.
export function judge(
  c: Pick<CaseManifest, "expected" | "added" | "packages">,
  usage: Record<string, PackageUsageFacts>
): { weak: boolean; evidence: Evidence[] } {
  const evidence: Evidence[] = []
  for (const p of c.packages) {
    const facts = usage[p.name]
    const removed = c.expected.filter((e) => e.imports.includes(p.name))
    if (!facts || removed.length === 0) continue
    const files = new Set(removed.map((e) => e.file))
    const keys = removed.map((e) => `${e.file}:${e.line}`)
    const sites = new Set(facts.sites.map((s) => `${s.file}:${s.line}`))
    const options = new Set(facts.options ?? [])
    const types = new Set(facts.types ?? [])
    const imports = new Set(facts.imports ?? [])
    const texts = [
      ...removed.map((e) => e.text),
      ...c.added.filter((a) => files.has(a.file)).map((a) => a.text),
    ]
    const names = facts.names.filter((n) => {
      const re = new RegExp(`(?<![\\w$])${escape(n)}(?![\\w$])`)
      return texts.some((t) => re.test(t))
    })
    const e: Evidence = {
      package: p.name,
      onSite: keys.filter((k) => sites.has(k)),
      options: keys.filter((k) => options.has(k)),
      types: keys.filter((k) => types.has(k)),
      imports: keys.filter((k) => imports.has(k)),
      names,
    }
    const count =
      e.onSite.length +
      e.options.length +
      e.types.length +
      e.imports.length +
      names.length
    if (count > 0) evidence.push(e)
  }
  return { weak: evidence.length === 0, evidence }
}

// A fix whose expected lines mostly only changed layout is a formatter's work, whatever the lines
// use: a reformatted test file is full of calls to the package.
export function resultOf(
  verdict: { weak: boolean },
  labels: Pick<CaseManifest["labels"], "expectedReformatShare">
): CheckResult {
  if (labels.expectedReformatShare >= REFORMAT_SHARE) return "reformat"
  return verdict.weak ? "weak" : "supported"
}

export interface CheckOptions {
  data: string
  limit: number
  npm: Npm
  log: (line: string) => void
}

interface Snapshot {
  usage: Record<string, PackageUsageFacts>
  installed: Set<string>
}

async function readSnapshot(data: string, c: CaseManifest): Promise<Snapshot> {
  const root = await prepareSnapshot(data, c)
  const files = await listProjectFiles(root)
  const inventory = await buildInventory(root, { prod: false }, files)
  const scan = await scanUsage(undefined, root, files, inventory)
  const usage: Record<string, PackageUsageFacts> = {}
  for (const u of Object.values(scan.packages)) {
    if (!c.packages.some((p) => p.name === u.pkg)) continue
    const prev = usage[u.pkg] ?? { names: [], sites: [] }
    usage[u.pkg] = {
      names: [...new Set([...prev.names, ...u.strongNames, ...u.weakNames])],
      sites: [...prev.sites, ...u.refs.map((r) => r.site)],
    }
  }
  const expectedFiles = new Set(c.expected.map((e) => e.file))
  for (const p of c.packages) {
    const options: string[] = []
    const types: string[] = []
    const imports: string[] = []
    for (const file of expectedFiles) {
      if (
        !c.expected.some((e) => e.file === file && e.imports.includes(p.name))
      )
        continue
      let text: string
      try {
        text = readFileSync(join(root, file), "utf8")
      } catch {
        continue
      }
      const lines = packageLines(file, text, p.name)
      for (const l of lines.options) options.push(`${file}:${l}`)
      for (const l of lines.types) types.push(`${file}:${l}`)
      for (const l of lines.imports) imports.push(`${file}:${l}`)
    }
    const facts = (usage[p.name] ??= { names: [], sites: [] })
    facts.options = options
    facts.types = types
    facts.imports = imports
  }
  return {
    usage,
    installed: new Set(inventory.installed.map((d) => d.name)),
  }
}

export async function check(o: CheckOptions): Promise<Review[]> {
  const reviews: Review[] = []
  for (const c of loadCases(o.data).slice(0, o.limit)) {
    const base = {
      id: c.id,
      url: c.url,
      title: c.title,
      packages: c.packages.map((p) => `${p.name} ${p.from} -> ${p.to}`),
      expected: c.expected.length,
      testsOnly: c.expected.every((e) => isTestFile(e.file)),
      expectedReformatShare: c.labels.expectedReformatShare,
    }
    let review: Review
    try {
      const snap = await readSnapshot(o.data, c)
      const verdict = judge(c, snap.usage)
      const types: Record<string, TypesSource> = {}
      for (const p of c.packages)
        types[p.name] = await typesSource(
          o.npm,
          p,
          snap.installed.has(atTypesName(p.name))
        )
      review = { ...base, ...verdict, result: resultOf(verdict, c.labels) }
      c.labels = {
        ...c.labels,
        testsOnly: base.testsOnly,
        types,
        check: review.result,
      }
    } catch (e) {
      review = {
        ...base,
        result: "error",
        weak: true,
        evidence: [],
        error: String(e).slice(0, 300),
      }
      c.labels = { ...c.labels, check: "error" }
    }
    saveCase(o.data, c)
    reviews.push(review)
    // a locked case's evidence is its expected lines: nothing of it reaches the terminal
    o.log(
      c.split === "locked"
        ? `${c.id}: locked, checked`
        : `${c.id}: ${review.result}${review.testsOnly ? ", tests only" : ""}${review.error ? ` ${review.error.slice(0, 200)}` : ""}`
    )
  }
  const cases = loadCases(o.data)
  const locked = new Set(
    cases.filter((c) => c.split === "locked").map((c) => c.id)
  )
  const working = reviews.filter((r) => !locked.has(r.id))
  const hidden = reviews.filter((r) => locked.has(r.id))
  writeJson(join(o.data, "review.json"), working)
  writeFileSync(join(o.data, "review.md"), renderReview(working, cases))
  writeJson(join(o.data, "locked", "review.json"), hidden)
  writeFileSync(
    join(o.data, "locked", "review.md"),
    renderReview(hidden, cases)
  )
  return reviews
}

const HEADINGS: Record<Exclude<CheckResult, "supported">, string> = {
  weak: "Weak: no changed line uses an upgraded package, is an option or a type of one, or names what the code uses from one",
  reformat:
    "Reformat: most expected lines only changed whitespace, quotes, semicolons, commas or order",
  error: "Error: the snapshot could not be read",
}

// The cases a person should read, each with what a reviewer needs to decide without opening
// anything else first.
export function renderReview(reviews: Review[], cases: CaseManifest[]): string {
  const count = (r: CheckResult) => reviews.filter((x) => x.result === r).length
  const out = [
    "# Cases to review",
    "",
    `${reviews.length} cases: ${count("supported")} supported, ${count("weak")} weak, ${count("reformat")} reformat, ${count("error")} errors; ${reviews.filter((r) => r.testsOnly).length} fix tests only.`,
    "Keep a case when the fix answers the upgrade; delete its manifest from `cases/` otherwise.",
    "",
  ]
  for (const kind of ["reformat", "weak", "error"] as const) {
    const listed = reviews.filter((r) => r.result === kind)
    if (listed.length === 0) continue
    out.push(`## ${HEADINGS[kind]}`, "")
    for (const r of listed) {
      const c = cases.find((x) => x.id === r.id)
      out.push(
        `### ${r.id}${r.testsOnly ? " (tests only)" : ""}`,
        "",
        `${r.title}`,
        "",
        r.url,
        ""
      )
      for (const p of r.packages) out.push(`- ${p}`)
      if (r.error) out.push("", `error: ${r.error}`)
      if (c) {
        out.push("", "```")
        for (const e of c.expected.slice(0, 15))
          out.push(`${e.file}:${e.line}  ${e.text.trim().slice(0, 100)}`)
        if (c.expected.length > 15)
          out.push(`... ${c.expected.length - 15} more`)
        out.push("```")
      }
      out.push("")
    }
  }
  return out.join("\n")
}
