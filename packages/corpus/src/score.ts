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

// The same rule as the benchmark harness, without its knowledge of which note is the change: any
// matched note counts, since a mined case does not know which note the fix answers.
export function scorePackage(
  c: Pick<CaseManifest, "expected">,
  upgrade: CaseManifest["packages"][number],
  brief: Brief
): PackageScore {
  const expected = new Set(
    c.expected
      .filter((e) => e.imports.includes(upgrade.name))
      .map((e) => `${e.file}:${e.line}`)
  )
  const files = new Set(
    c.expected
      .filter((e) => e.imports.includes(upgrade.name))
      .map((e) => e.file)
  )
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
  const noteSites = pkg.notes.matched.flatMap((m) =>
    m.hits.flatMap((h) => pkg.usage.byName[h.name] ?? [])
  )
  const typeSites = pkg.surface.touched.flatMap((t) => t.sites)
  const hit = (sites: { file: string; line: number }[]) =>
    sites.some((s) => expected.has(`${s.file}:${s.line}`))
  const foundBy: PackageScore["foundBy"] = []
  if (hit(noteSites)) foundBy.push("notes")
  if (hit(typeSites)) foundBy.push("types")
  return {
    ...base,
    verdict: pkg.verdict,
    found: foundBy.length > 0,
    foundBy,
    sameFile: [...noteSites, ...typeSites].some((s) => files.has(s.file)),
    matchedNotes: pkg.notes.matched.length,
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
}

export function totals(results: CaseResult[]): Totals {
  const ok = results.filter((r) => !r.error)
  const scoredOf = (r: CaseResult) => r.packages.filter((p) => p.expected > 0)
  const scored = ok.filter((r) => scoredOf(r).length > 0)
  const pkgs = ok.flatMap(scoredOf)
  const analysed = pkgs.filter((p) => p.verdict !== "not-analysed")
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
  }
}
