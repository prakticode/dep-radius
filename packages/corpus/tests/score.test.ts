import { describe, expect, it } from "vitest"

import type { Brief, PackageBrief, Site } from "@dep-radius/core"

import type { CaseManifest } from "../src/case.ts"
import {
  type CaseResult,
  median,
  type PackageScore,
  scorePackage,
  totals,
} from "../src/score.ts"

function site(file: string, line: number): Site {
  return { file, line, col: 1, typeOnly: false, text: "" }
}

function entry(id: string) {
  return {
    id,
    version: "2.0.0",
    title: id,
    headingPath: [],
    regions: [],
    breakingMarker: false,
    noise: false,
    refs: [],
  }
}

function pkgBrief(over: {
  pkg: string
  verdict?: PackageBrief["verdict"]
  matched?: { name: string }[]
  touched?: Site[]
  byName?: Record<string, Site[]>
  cannotTie?: number
}): PackageBrief {
  return {
    pkg: over.pkg,
    from: "1.0.0",
    to: "2.0.0",
    verdict: over.verdict ?? "review",
    surface: {
      status: "computed",
      touched: over.touched
        ? [
            {
              change: { path: "x", kind: "function", alsoAt: [] },
              bucket: "changed",
              strength: "strong",
              sites: over.touched,
            },
          ]
        : [],
    },
    notes: {
      coverage: "complete",
      perVersion: [],
      total: 10,
      matched: (over.matched ?? []).map((m) => ({
        entry: entry(m.name),
        hits: [{ name: m.name, strength: "strong", region: "prose" }],
        direct: true,
      })),
      unattributedBreaking: [],
      unattributedChanges: Array.from({ length: over.cannotTie ?? 0 }, (_, i) =>
        entry(`u${i}`)
      ),
    },
    usage: { byName: over.byName ?? {} },
  } as unknown as PackageBrief
}

function brief(packages: PackageBrief[], notAnalyzed = []): Brief {
  return { packages, notAnalyzed } as unknown as Brief
}

const kase: Pick<CaseManifest, "expected"> = {
  expected: [
    { file: "src/a.ts", line: 3, text: "", imports: ["zod"] },
    { file: "src/a.ts", line: 9, text: "", imports: ["zod", "express"] },
    { file: "src/b.ts", line: 1, text: "", imports: ["express"] },
  ],
}
const zod = { name: "zod", from: "3.0.0", to: "4.0.0" }

describe("scorePackage", () => {
  it("finds a case when a matched note's name is used on an expected line", () => {
    const s = scorePackage(
      kase,
      zod,
      brief([
        pkgBrief({
          pkg: "zod",
          matched: [{ name: "uuid" }],
          byName: { uuid: [site("src/a.ts", 9)] },
          cannotTie: 4,
        }),
      ])
    )
    expect(s).toMatchObject({
      verdict: "review",
      expected: 2,
      found: true,
      foundBy: ["notes"],
      matchedNotes: 1,
      cannotTie: 4,
    })
  })

  it("finds a case through a touched type change", () => {
    const s = scorePackage(
      kase,
      zod,
      brief([pkgBrief({ pkg: "zod", touched: [site("src/a.ts", 3)] })])
    )
    expect(s.foundBy).toEqual(["types"])
  })

  it("counts only the lines of files importing the package", () => {
    const s = scorePackage(
      kase,
      zod,
      brief([
        pkgBrief({
          pkg: "zod",
          matched: [{ name: "parse" }],
          byName: { parse: [site("src/b.ts", 1)] },
        }),
      ])
    )
    expect(s.found).toBe(false)
    expect(s.sameFile).toBe(false)
  })

  it("marks a link to another line of an expected file as a near miss", () => {
    const s = scorePackage(
      kase,
      zod,
      brief([pkgBrief({ pkg: "zod", touched: [site("src/a.ts", 40)] })])
    )
    expect(s).toMatchObject({ found: false, sameFile: true })
  })

  it("reports a package radius did not analyse, with its reason", () => {
    const s = scorePackage(
      kase,
      zod,
      brief(
        [],
        // @ts-expect-error a partial brief
        [{ pkg: "zod", reason: "registry: not-found" }]
      )
    )
    expect(s).toMatchObject({
      verdict: "not-analysed",
      notAnalysed: "registry: not-found",
      found: false,
    })
  })
})

describe("totals", () => {
  const score = (over: Partial<PackageScore>): PackageScore => ({
    name: "p",
    from: "1.0.0",
    to: "2.0.0",
    verdict: "review",
    expected: 1,
    found: false,
    foundBy: [],
    sameFile: false,
    matchedNotes: 0,
    cannotTie: 0,
    ...over,
  })
  const result = (id: string, packages: PackageScore[], error?: string) =>
    ({
      id,
      repo: "o/r",
      pr: 1,
      evaluatedAt: "",
      packages,
      ...(error ? { error } : {}),
    }) satisfies CaseResult

  it("counts found and wrong quiet per case and per package", () => {
    const t = totals([
      result("a", [
        score({ found: true, cannotTie: 2, matchedNotes: 3 }),
        score({ verdict: "quiet", cannotTie: 0 }),
      ]),
      result("b", [
        score({ verdict: "quiet", cannotTie: 6 }),
        score({ verdict: "quiet", expected: 0 }),
      ]),
      result("c", [score({ verdict: "not-analysed" })]),
      result("d", [], "boom"),
    ])
    expect(t).toEqual({
      cases: 4,
      errors: 1,
      scoredCases: 3,
      foundCases: 1,
      packages: 4,
      foundPackages: 1,
      wrongQuietCases: 1,
      wrongQuietPackages: 2,
      notAnalysedPackages: 1,
      medianCannotTie: 2,
      medianMatchedNotes: 0,
    })
  })

  it("does not call a case quiet when another of its upgrades asks for review", () => {
    const t = totals([
      result("a", [
        score({ verdict: "quiet" }),
        score({ verdict: "review", expected: 0 }),
      ]),
    ])
    expect(t.wrongQuietCases).toBe(0)
    expect(t.wrongQuietPackages).toBe(1)
  })
})

describe("median", () => {
  it("averages the two middle values of an even list", () => {
    expect(median([])).toBe(0)
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})
