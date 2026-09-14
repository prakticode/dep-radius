import { join, relative } from "node:path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"

import { run } from "../../src/run.ts"
import { splitEntries } from "../../src/notes/entries.ts"
import type { NoteEntry, PackageBrief } from "../../src/model.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import {
  type FakePackage,
  FakeRegistry,
  testCtx,
  testOptions,
} from "../helpers/fake-registry.ts"

// A documented behaviour change from a real release, and the lines of a project it lands on. The
// notes are copied verbatim from the release; the project is small and uses the package the way
// real code does. `status` records what radius does today, so a case that starts or stops being
// caught fails the test until someone updates it on purpose.
export interface BenchmarkCase {
  id: string
  package: string
  from: string
  to: string
  repository: string
  // version -> where the notes were copied from
  sources: Record<string, string>
  // words copied from the notes that only the entries describing the change contain; any one of
  // those entries linked to an expected line counts
  change: string[]
  why: string
  // file:line sites, relative to the project
  expect: string[]
  status: "caught" | "missed"
}

export interface CaseResult {
  id: string
  package: string
  status: "caught" | "missed"
  // the upgrade's verdict: quiet on a case is an upgrade radius would let through unread
  verdict: PackageBrief["verdict"]
  // the change's entry matched at all, even without reaching an expected line
  entryMatched: boolean
  sitesFound: number
  sitesExpected: number
  // matched entries that are not the change: what a reader skims past
  otherMatches: number
  entries: number
}

export const CASES_DIR = join(import.meta.dirname, "cases")

export function loadCases(dir = CASES_DIR): BenchmarkCase[] {
  return readdirSync(dir)
    .filter((id) => statSync(join(dir, id)).isDirectory())
    .sort()
    .map((id) => {
      const c = JSON.parse(
        readFileSync(join(dir, id, "case.json"), "utf8")
      ) as Omit<BenchmarkCase, "id">
      return { id, ...c }
    })
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out[relative(root, abs)] = readFileSync(abs, "utf8")
    }
  }
  walk(root)
  return out
}

function notesOf(c: BenchmarkCase, dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const version of Object.keys(c.sources))
    out[version] = readFileSync(join(dir, "notes", `${version}.md`), "utf8")
  return out
}

// The words of an entry, compared without what markdown and entry splitting put around them:
// backticks, emphasis and spacing ("**Fetch adapter**", "NaN )").
function squash(text: string): string {
  return text.replace(/[`*_\s]/g, "")
}

function entryText(e: NoteEntry): string {
  return squash([e.title, ...e.regions.map((r) => r.text)].join(""))
}

function describesChange(c: BenchmarkCase, e: NoteEntry): boolean {
  const text = entryText(e)
  return c.change.some((words) => text.includes(squash(words)))
}

// A case whose change is in no entry of its own notes measures nothing: fail loudly instead. Every
// set of words must be in the notes, and at least one in an entry as radius splits them (a summary
// bullet repeated by a detailed entry is dropped as a duplicate).
export function assertWellFormed(c: BenchmarkCase, dir = CASES_DIR): void {
  const notes = notesOf(c, join(dir, c.id))
  const all = squash(Object.values(notes).join(""))
  for (const words of c.change)
    if (!all.includes(squash(words)))
      throw new Error(`${c.id}: the notes do not contain "${words}"`)
  const entries = Object.entries(notes).flatMap(([version, body]) =>
    splitEntries(version, body)
  )
  if (!entries.some((e) => describesChange(c, e)))
    throw new Error(`${c.id}: no entry of the notes describes the change`)
}

// The packages whose types the case's package imports, served next to it: each version's real
// package.json and declarations under dependencies/<name>@<version>, a scope as its own folder
// (dependencies/@tanstack/query-core@5.100.14).
function dependenciesOf(caseDir: string): FakePackage[] {
  const root = join(caseDir, "dependencies")
  if (!existsSync(root)) return []
  const byName = new Map<string, FakePackage>()
  const folders = readdirSync(root).flatMap((name) =>
    name.startsWith("@")
      ? readdirSync(join(root, name)).map((inner) => `${name}/${inner}`)
      : [name]
  )
  for (const folder of folders.sort()) {
    const at = folder.lastIndexOf("@")
    if (at <= 0) throw new Error(`${folder}: expected <name>@<version>`)
    const name = folder.slice(0, at)
    const pkg = byName.get(name) ?? { name, versions: [] }
    pkg.versions.push({
      version: folder.slice(at + 1),
      publishedAt: "2026-01-01T00:00:00Z",
      files: readTree(join(root, folder)),
    })
    byName.set(name, pkg)
  }
  return [...byName.values()]
}

export async function runCase(
  c: BenchmarkCase,
  dir = CASES_DIR
): Promise<CaseResult> {
  const caseDir = join(dir, c.id)
  const notes = notesOf(c, caseDir)
  // a case that needs the package's types ships its real declarations under package/<version>
  const typesDir = join(caseDir, "package")
  const withTypes = existsSync(typesDir)
  const tarball = (version: string) => ({
    version,
    publishedAt: "2026-01-01T00:00:00Z",
    files: withTypes
      ? readTree(join(typesDir, version))
      : {
          "package.json": JSON.stringify({
            name: c.package,
            version,
            main: "index.js",
          }),
          "index.js": "module.exports = {}",
        },
  })
  const registry = new FakeRegistry([
    {
      name: c.package,
      repository: `git+${c.repository}.git`,
      versions: [tarball(c.from), tarball(c.to)],
      releases: Object.fromEntries(
        Object.entries(notes).map(([v, body]) => [`v${v}`, body])
      ),
    },
    ...dependenciesOf(caseDir),
  ])
  const project = createProject({
    files: {
      "package.json": pkgJson({
        name: "benchmark-project",
        private: true,
        dependencies: { [c.package]: `^${c.from}` },
      }),
      [`node_modules/${c.package}/package.json`]: JSON.stringify({
        name: c.package,
        version: c.from,
      }),
      ...readTree(join(caseDir, "project")),
    },
  })
  try {
    // the notes, with the types only where a case ships them: they tell which options a call takes
    const opts = testOptions(project.root, {
      specs: [`${c.package}@${c.to}`],
      surface: withTypes,
    })
    const brief = await run(opts, testCtx(opts, registry))
    const pkg = brief.packages.find((p) => p.pkg === c.package)
    if (!pkg)
      throw new Error(
        `${c.id}: no brief for ${c.package}: ${JSON.stringify(brief.notAnalyzed)}`
      )
    return score(c, pkg)
  } finally {
    project.cleanup()
  }
}

function score(c: BenchmarkCase, pkg: PackageBrief): CaseResult {
  const changeMatches = pkg.notes.matched.filter((m) =>
    describesChange(c, m.entry)
  )
  const linked = new Set<string>()
  for (const m of changeMatches)
    for (const h of m.hits)
      for (const s of pkg.usage.byName[h.name] ?? [])
        linked.add(`${s.file}:${s.line}`)
  const sitesFound = c.expect.filter((s) => linked.has(s)).length
  return {
    id: c.id,
    package: c.package,
    status: sitesFound > 0 ? "caught" : "missed",
    verdict: pkg.verdict,
    entryMatched: changeMatches.length > 0,
    sitesFound,
    sitesExpected: c.expect.length,
    otherMatches: pkg.notes.matched.length - changeMatches.length,
    entries: pkg.notes.total,
  }
}

export interface Totals {
  cases: number
  caught: number
  recall: number
  // of all the entries a reader is shown across the cases, the share that is the change
  precision: number
  // cases called quiet: a documented change to code the project uses, let through unread
  quiet: number
}

export function totals(results: CaseResult[]): Totals {
  const caught = results.filter((r) => r.status === "caught").length
  const relevant = results.filter((r) => r.entryMatched).length
  const shown = results.reduce((n, r) => n + r.otherMatches, relevant)
  return {
    cases: results.length,
    caught,
    recall: results.length ? caught / results.length : 0,
    precision: shown ? relevant / shown : 0,
    quiet: results.filter((r) => r.verdict === "quiet").length,
  }
}
