import { describe, expect, it } from "vitest"

import { decide, type VerdictInput } from "../../src/analyze/verdict.ts"
import type { NoteEntry, PackageUsage, Touched } from "../../src/model.ts"

const usage = (over: Partial<PackageUsage> = {}): PackageUsage => ({
  installedId: "x",
  pkg: "x",
  refs: [
    {
      installedId: "x",
      pkg: "x",
      specifier: "x",
      entry: ".",
      binding: { kind: "named", imported: "thing" },
      chain: [],
      callSelf: true,
      site: { file: "a.ts", line: 1, col: 1, typeOnly: false, text: "" },
    },
  ],
  strongNames: ["thing"],
  weakNames: [],
  files: 1,
  opaque: [],
  blindSpots: [],
  ...over,
})

const clean = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  bump: "minor",
  zeroMajor: false,
  flags: [],
  usage: usage(),
  surface: { status: "computed", changes: 3, touched: [] },
  notes: {
    coverage: "complete",
    perVersion: [],
    total: 4,
    matched: [],
    unattributedBreaking: [],
    unattributedChanges: [],
  },
  ...over,
})

const touch = (
  bucket: Touched["bucket"],
  strength: Touched["strength"] = "strong"
): Touched => ({
  change: { path: "x:thing", kind: "function", alsoAt: [] },
  bucket,
  strength,
  sites: [],
})

const entry: NoteEntry = {
  id: "1",
  version: "1.1.0",
  title: "t",
  headingPath: [],
  regions: [],
  breakingMarker: true,
  noise: false,
  kind: "change",
  refs: [],
}

describe("decide", () => {
  it("is quiet when both nets are complete and clean", () => {
    const r = decide(clean())
    expect(r.verdict).toBe("quiet")
    expect(r.reasons.map((x) => x.code)).toEqual([
      "notes-complete-no-match",
      "surface-clean",
    ])
  })

  it("blocks on a removed export in use, and only then", () => {
    expect(
      decide(
        clean({ surface: { status: "computed", touched: [touch("removed")] } })
      ).verdict
    ).toBe("blocked")
    expect(
      decide(
        clean({
          surface: { status: "computed", touched: [touch("removed", "weak")] },
        })
      ).verdict
    ).toBe("review")
    expect(
      decide(
        clean({ surface: { status: "computed", touched: [touch("changed")] } })
      ).verdict
    ).toBe("review")
  })

  it("reviews, with the reason, when the new types could not show a name you use", () => {
    const detail =
      "1 name you use may have moved to query-core, which 5.102.8 re-exports and radius does not follow"
    const r = decide(
      clean({
        surface: { status: "computed", detail, touched: [], incomplete: true },
      })
    )
    expect(r.verdict).toBe("review")
    expect(r.reasons).toEqual([{ code: "surface-incomplete", detail }])
  })

  it("reviews on notes, on breaking notes naming no API, and on blind spots", () => {
    const withNote = clean({
      notes: {
        coverage: "complete",
        perVersion: [],
        total: 1,
        matched: [{ entry, hits: [], direct: true }],
        unattributedBreaking: [],
        unattributedChanges: [],
      },
    })
    expect(decide(withNote).verdict).toBe("review")
    expect(
      decide(
        clean({
          notes: {
            coverage: "complete",
            perVersion: [],
            total: 1,
            matched: [],
            unattributedBreaking: [entry],
            unattributedChanges: [],
          },
        })
      ).verdict
    ).toBe("review")
    expect(
      decide(
        clean({
          usage: usage({
            blindSpots: [{ kind: "namespace-escape", count: 1, examples: [] }],
          }),
        })
      ).verdict
    ).toBe("review")
  })

  it("never calls an update quiet while a note describes a change it cannot tie to the code", () => {
    const d = decide(
      clean({
        notes: {
          coverage: "complete",
          perVersion: [],
          total: 3,
          matched: [],
          unattributedBreaking: [],
          unattributedChanges: [entry, entry],
        },
      })
    )
    expect(d.verdict).toBe("review")
    expect(d.reasons).toEqual([
      {
        code: "unattributed-change",
        detail:
          "2 release notes describe changes radius cannot tie to your code",
      },
    ])
  })

  it("never calls side effect, config or script usage quiet", () => {
    for (const kind of [
      "side-effect-import",
      "config-reference",
      "script-bin",
      "css-import",
      "convention-framework",
    ] as const) {
      const r = decide(
        clean({
          usage: usage({
            refs: [],
            opaque: [{ kind, count: 1, examples: [] }],
          }),
        })
      )
      expect(r.verdict, kind).toBe("review")
    }
  })

  it("never calls a package quiet while a source it skipped disagrees with the manifest", () => {
    const r = decide(
      clean({
        outOfSync: [
          { source: "lockfile:npm", version: "2.3.0", spec: "2.4.0" },
          { source: "lockfile:npm", version: "2.3.0", spec: "2.4.0" },
          {
            source: "node_modules",
            version: "1.0.0",
            spec: "^1.0.1",
            at: "main",
          },
        ],
      })
    )
    expect(r.verdict).toBe("review")
    expect(r.reasons).toContainEqual({
      code: "out-of-sync",
      detail:
        "package.json asks for 2.4.0 but the lockfile has 2.3.0, so that version was not used; at main, package.json asks for ^1.0.1 but node_modules has 1.0.0, so that version was not used",
    })
  })

  it("never calls an unreferenced package quiet", () => {
    expect(
      decide(clean({ usage: undefined })).reasons.map((x) => x.code)
    ).toContain("not-referenced")
  })

  it("is quiet on one complete net, and says which one was missing", () => {
    const r = decide(clean({ surface: { status: "no-types", touched: [] } }))
    expect(r.verdict).toBe("quiet")
    expect(r.reasons.map((x) => x.code)).toContain("caveat-no-types")
  })

  it("reviews when neither net is complete", () => {
    const r = decide(
      clean({
        surface: { status: "no-types", touched: [] },
        notes: {
          coverage: "none-published",
          perVersion: [],
          total: 0,
          matched: [],
          unattributedBreaking: [],
          unattributedChanges: [],
        },
      })
    )
    expect(r.verdict).toBe("review")
  })

  it("lets a major be quiet only with both nets complete and clean", () => {
    expect(decide(clean({ bump: "major" })).verdict).toBe("quiet")
    expect(
      decide(
        clean({ bump: "major", surface: { status: "no-types", touched: [] } })
      ).verdict
    ).toBe("review")
  })

  it("reviews when types live in another package, or the install is patched", () => {
    expect(
      decide(clean({ surface: { status: "types-elsewhere", touched: [] } }))
        .verdict
    ).toBe("review")
    expect(decide(clean({ flags: ["patched"] })).verdict).toBe("review")
  })
})
