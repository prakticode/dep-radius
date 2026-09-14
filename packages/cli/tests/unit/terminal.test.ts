import { describe, expect, it } from "vitest"

import type { Brief, PackageBrief, Site } from "@dep-radius/core"

import { renderTerminal } from "../../src/render/terminal.ts"

const NOW = Date.parse("2026-09-13T09:00:00Z")

const site = (file: string, line: number, via?: string[]): Site => ({
  file,
  line,
  col: 1,
  typeOnly: false,
  text: "",
  ...(via ? { via } : {}),
})

function pkg(
  over: Partial<PackageBrief> & Pick<PackageBrief, "pkg" | "verdict">
): PackageBrief {
  return {
    from: "1.0.0",
    to: "1.1.0",
    bump: "minor",
    publishedAt: "2026-09-10T09:00:00Z",
    versionSource: "node_modules",
    manifests: ["package.json"],
    level: 1,
    reasons: [],
    surface: { status: "computed", changes: 0, touched: [] },
    notes: {
      coverage: "complete",
      perVersion: [],
      total: 0,
      matched: [],
      unattributedBreaking: [],
      unattributedChanges: [],
    },
    usage: {
      files: 1,
      sites: [],
      byName: {},
      strongNames: [],
      weakNames: [],
      opaque: [],
      blindSpots: [],
    },
    skippedNewer: [],
    ...over,
  }
}

const brief: Brief = {
  schemaVersion: 1,
  tool: { version: "0.0.0", typescript: "6.0.3" },
  root: "/project",
  generatedAt: new Date(NOW).toISOString(),
  manifests: 1,
  upToDate: 3,
  notAnalyzed: [],
  global: [],
  limits: ["Transitive dependencies are out of scope."],
  exitCode: 2,
  packages: [
    pkg({
      pkg: "acme-blocked",
      verdict: "blocked",
      reasons: [
        {
          code: "removed-touched",
          detail: "1 removed export you use: acme-blocked:legacy",
        },
      ],
      surface: {
        status: "computed",
        changes: 1,
        touched: [
          {
            change: {
              path: "acme-blocked:legacy",
              kind: "function",
              before: ["() => void"],
              alsoAt: [],
            },
            bucket: "removed",
            strength: "strong",
            sites: [site("src/blocked.ts", 3, ["src/proxy.ts"])],
          },
        ],
      },
    }),
    pkg({
      pkg: "acme-quiet",
      verdict: "quiet",
      reasons: [
        {
          code: "notes-complete-no-match",
          detail: "every release note read, none mentions what you use",
        },
      ],
    }),
    pkg({
      pkg: "acme-cli",
      verdict: "review",
      reasons: [
        {
          code: "opaque-usage",
          detail: "used in ways names cannot show: run from scripts",
        },
      ],
      usage: {
        files: 0,
        sites: [],
        byName: {},
        strongNames: [],
        weakNames: [],
        opaque: [
          { kind: "script-bin", count: 1, examples: [site("package.json", 1)] },
        ],
        blindSpots: [],
      },
    }),
  ],
}

describe("renderTerminal", () => {
  const text = renderTerminal(brief, { color: false, verbose: false, now: NOW })

  it("details what blocks, with the site and the file it went through", () => {
    expect(text).toContain("acme-blocked  1.0.0 → 1.1.0  minor")
    expect(text).toContain("BLOCKED")
    expect(text).toContain("removed  acme-blocked:legacy")
    expect(text).toContain("src/blocked.ts:3  (via src/proxy.ts)")
  })

  it("lists quiet packages on one line and what it cannot see on another", () => {
    expect(text).toContain("quiet (1)")
    expect(text).toContain("acme-quiet 1.0.0 → 1.1.0")
    expect(text).toContain("cannot see how you use these (1)")
    expect(text).toContain("acme-cli 1.0.0 → 1.1.0")
  })

  it("shows a breaking note tied to the code before a change matched by member name", () => {
    const review = pkg({
      pkg: "acme-mixed",
      verdict: "review",
      surface: {
        status: "computed",
        changes: 1,
        touched: [
          {
            change: {
              path: "acme-mixed:Ctx#issues",
              kind: "member",
              alsoAt: [],
            },
            bucket: "changed",
            strength: "weak",
            sites: [site("src/a.test.ts", 5)],
          },
        ],
      },
      notes: {
        coverage: "complete",
        perVersion: [],
        total: 2,
        matched: [
          {
            entry: {
              id: "a",
              version: "1.1.0",
              title: "⚠️ String length counts code points",
              headingPath: [],
              regions: [],
              breakingMarker: true,
              noise: false,
              kind: "change",
              refs: [],
            },
            hits: [{ name: "max", strength: "strong", region: "inline-code" }],
            direct: true,
          },
        ],
        unattributedBreaking: [],
        unattributedChanges: [],
      },
      usage: {
        files: 1,
        sites: [],
        byName: { max: [site("src/schema.ts", 4)] },
        strongNames: ["max"],
        weakNames: [],
        opaque: [],
        blindSpots: [],
      },
    })
    const out = renderTerminal(
      { ...brief, packages: [review] },
      { color: false, verbose: false, now: NOW }
    )
    expect(out.indexOf("String length counts code points")).toBeGreaterThan(-1)
    expect(out.indexOf("String length counts code points")).toBeLessThan(
      out.indexOf("acme-mixed:Ctx#issues")
    )
    expect(out).toContain("src/schema.ts:4")
  })

  it("ends with the limits and a one-line summary", () => {
    expect(text).toContain("Transitive dependencies are out of scope.")
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      "3 with an update  1 quiet · 1 review · 1 blocked  · 3 up to date"
    )
  })
})
