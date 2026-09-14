import type { Brief, PackageBrief } from "@dep-radius/core"

import type { CaseManifest } from "./case.ts"

export type Verdict = PackageBrief["verdict"] | "not-analysed"

export interface PackageScore {
  name: string
  from: string
  to: string
  verdict: Verdict
  // why radius gave no brief, when it gave none
  notAnalysed?: string
  expected: number
  // a matched note or a touched type change links to an expected line
  found: boolean
  foundBy: ("notes" | "types")[]
  // a link lands in a file the fix changed, on another line: a near miss worth reading
  sameFile: boolean
  matchedNotes: number
  // matched notes that link to at least one expected line
  matchedNotesHit?: number
  // distinct lines radius points at for the package, through matched notes and touched type
  // changes, and how many of them the fix changed
  reportedLines?: number
  reportedHits?: number
  // the notes radius cannot tie to any name: the list a reader goes through
  cannotTie: number
  notesCoverage?: string
  surface?: string
}

export interface CaseResult {
  id: string
  repo: string
  pr: number
  evaluatedAt: string
  packages: PackageScore[]
  error?: string
}

type Line = { file: string; line: number }

const keyOf = (s: Line) => `${s.file}:${s.line}`

// The same rule as the benchmark harness, without its knowledge of which note is the change: any
// matched note counts, since a mined case does not know which note the fix answers.
export function scorePackage(
  c: Pick<CaseManifest, "expected">,
  upgrade: CaseManifest["packages"][number],
  brief: Brief
): PackageScore {
  const mine = c.expected.filter((e) => e.imports.includes(upgrade.name))
  const expected = new Set(mine.map(keyOf))
  const files = new Set(mine.map((e) => e.file))
  const base = {
    name: upgrade.name,
    from: upgrade.from,
    to: upgrade.to,
    expected: expected.size,
  }
  const pkg = brief.packages.find((p) => p.pkg === upgrade.name)
  if (!pkg) {
    const why = brief.notAnalyzed.find((n) => n.pkg === upgrade.name)
    return {
      ...base,
      verdict: "not-analysed",
      notAnalysed: why?.reason ?? "no brief",
      found: false,
      foundBy: [],
      sameFile: false,
      matchedNotes: 0,
      cannotTie: 0,
    }
  }
  const sitesOf = (m: (typeof pkg.notes.matched)[number]) =>
    m.hits.flatMap((h) => pkg.usage.byName[h.name] ?? [])
  const noteSites = pkg.notes.matched.flatMap(sitesOf)
  const typeSites = pkg.surface.touched.flatMap((t) => t.sites)
  const hit = (sites: Line[]) => sites.some((s) => expected.has(keyOf(s)))
  const foundBy: PackageScore["foundBy"] = []
  if (hit(noteSites)) foundBy.push("notes")
  if (hit(typeSites)) foundBy.push("types")
  const reported = new Set([...noteSites, ...typeSites].map(keyOf))
  return {
    ...base,
    verdict: pkg.verdict,
    found: foundBy.length > 0,
    foundBy,
    sameFile: [...noteSites, ...typeSites].some((s) => files.has(s.file)),
    matchedNotes: pkg.notes.matched.length,
    matchedNotesHit: pkg.notes.matched.filter((m) => hit(sitesOf(m))).length,
    reportedLines: reported.size,
    reportedHits: [...reported].filter((k) => expected.has(k)).length,
    cannotTie: pkg.notes.unattributedChanges.length,
    notesCoverage: pkg.notes.coverage,
    surface: pkg.surface.status,
  }
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const RANK: Record<Verdict, number> = {
  "not-analysed": 0,
  quiet: 1,
  review: 2,
  blocked: 3,
}

export interface Totals {
  cases: number
  errors: number
  // cases with at least one package that has expected lines
  scoredCases: number
  foundCases: number
  // packages with expected lines
  packages: number
  foundPackages: number
  // cases radius calls quiet as a whole, though a person had to fix them: merged unread
  wrongQuietCases: number
  wrongQuietPackages: number
  notAnalysedPackages: number
  // over analysed packages with expected lines
  medianCannotTie: number
  medianMatchedNotes: number
  // over every analysed package of the cases, with expected lines or not: the lines radius points
  // at and those the fix changed, the matched notes and those linking to a changed line
  reportedLines: number
  reportedHits: number
  matchedNotes: number
  matchedNotesHit: number
  // every analysed package, and those radius calls quiet
  analysedPackages: number
  quietPackages: number
}

export function totals(results: CaseResult[]): Totals {
  const ok = results.filter((r) => !r.error)
  const scoredOf = (r: CaseResult) => r.packages.filter((p) => p.expected > 0)
  const scored = ok.filter((r) => scoredOf(r).length > 0)
  const pkgs = ok.flatMap(scoredOf)
  const analysed = pkgs.filter((p) => p.verdict !== "not-analysed")
  const every = ok
    .flatMap((r) => r.packages)
    .filter((p) => p.verdict !== "not-analysed")
  const sum = (f: (p: PackageScore) => number | undefined) =>
    every.reduce((n, p) => n + (f(p) ?? 0), 0)
  return {
    cases: results.length,
    errors: results.length - ok.length,
    scoredCases: scored.length,
    foundCases: scored.filter((r) => scoredOf(r).some((p) => p.found)).length,
    packages: pkgs.length,
    foundPackages: pkgs.filter((p) => p.found).length,
    wrongQuietCases: scored.filter(
      (r) => Math.max(...r.packages.map((p) => RANK[p.verdict])) === RANK.quiet
    ).length,
    wrongQuietPackages: analysed.filter((p) => p.verdict === "quiet").length,
    notAnalysedPackages: pkgs.length - analysed.length,
    medianCannotTie: median(analysed.map((p) => p.cannotTie)),
    medianMatchedNotes: median(analysed.map((p) => p.matchedNotes)),
    reportedLines: sum((p) => p.reportedLines),
    reportedHits: sum((p) => p.reportedHits),
    matchedNotes: sum((p) => p.matchedNotes),
    matchedNotesHit: sum((p) => p.matchedNotesHit),
    analysedPackages: every.length,
    quietPackages: every.filter((p) => p.verdict === "quiet").length,
  }
}
