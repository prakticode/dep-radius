import { describe, expect, it } from "vitest"

import { parseDiff } from "../src/diff.ts"
import {
  dayWindow,
  groupedTitle,
  halves,
  mineLabels,
  windowQuery,
} from "../src/mine.ts"

describe("search windows", () => {
  it("writes a day as a merge range and halves it, the newer half first", () => {
    const day = dayWindow("2026-09-10")
    expect(windowQuery(day)).toBe(
      "merged:2026-09-10T00:00:00Z..2026-09-10T23:59:59Z"
    )
    expect(halves(day)!.map(windowQuery)).toEqual([
      "merged:2026-09-10T12:00:00Z..2026-09-10T23:59:59Z",
      "merged:2026-09-10T00:00:00Z..2026-09-10T11:59:59Z",
    ])
  })

  it("stops halving at an hour", () => {
    expect(halves({ from: 0, to: 5_399_000 })).toBeUndefined()
  })
})

describe("groupedTitle", () => {
  it("recognises the titles of grouped updates, not single ones", () => {
    expect(groupedTitle("Update all non-major dependencies")).toBe(true)
    expect(
      groupedTitle("chore(deps): update devDependencies (non-major)")
    ).toBe(true)
    expect(groupedTitle("Lock file maintenance")).toBe(true)
    expect(groupedTitle("Update dependency eslint to v10 (major)")).toBe(false)
    expect(
      groupedTitle("fix(deps): update sentry-javascript monorepo to v10")
    ).toBe(false)
  })
})

describe("mineLabels", () => {
  const files = parseDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2,2 +2,2 @@",
      `-import { b } from 'b';`,
      `-const x = z.string().uuid()`,
      `+import { b } from "b"`,
      `+const x = z.uuid()`,
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -7 +7 @@",
      `-expect(z.string().uuid()).toBeTruthy()`,
      `+expect(z.uuid()).toBeTruthy()`,
      "",
    ].join("\n")
  )

  it("labels the bump, the layout share and whether the fix is in tests only", () => {
    const expected = [
      { file: "src/a.test.ts", line: 7, text: "", imports: ["zod"] },
    ]
    const out = mineLabels(
      "o/r",
      1,
      [{ name: "zod", from: "3.25.0", to: "4.1.0" }],
      files,
      expected
    )
    expect(out.labels).toEqual({
      bump: "major",
      testsOnly: true,
      reformatShare: 0.33,
      expectedReformatShare: 0,
    })
    expect(["working", "locked"]).toContain(out.split)
  })
})
