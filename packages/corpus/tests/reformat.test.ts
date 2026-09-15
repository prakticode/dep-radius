import { describe, expect, it } from "vitest"

import { parseDiff } from "../src/diff.ts"
import { normalizeLayout, reformattedLines } from "../src/reformat.ts"

function diff(file: string, hunks: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${hunks}`
}

describe("normalizeLayout", () => {
  it("ignores whitespace, quote style, semicolons, commas and arrow parentheses", () => {
    expect(normalizeLayout(`  foo('a', (x) => x);`)).toBe(
      normalizeLayout(`foo("a", x => x)`)
    )
  })
})

describe("reformattedLines", () => {
  it("takes quote and semicolon changes and reordered imports as layout", () => {
    const files = parseDiff(
      diff(
        "src/a.ts",
        [
          "@@ -1,3 +1,3 @@",
          `-import { b } from 'b';`,
          `-import { a } from 'a';`,
          `-const x = z.string().uuid();`,
          `+import { a } from "a"`,
          `+import { b } from "b"`,
          `+const x = z.uuid()`,
          "",
        ].join("\n")
      )
    )
    expect([...reformattedLines(files)].sort()).toEqual([
      "src/a.ts:1",
      "src/a.ts:2",
    ])
  })

  it("takes a call wrapped over several lines as layout", () => {
    const files = parseDiff(
      diff(
        "src/a.ts",
        [
          "@@ -4 +4,4 @@",
          `-  const out = render(<App />, { wrapper: Providers })`,
          `+  const out = render(<App />, {`,
          `+    wrapper: Providers,`,
          `+  })`,
          "",
        ].join("\n")
      )
    )
    expect([...reformattedLines(files)]).toEqual(["src/a.ts:4"])
  })

  it("does not take a rewritten call as layout", () => {
    const files = parseDiff(
      diff(
        "src/a.ts",
        ["@@ -4 +4 @@", `-  z.string().email()`, `+  z.email()`, ""].join("\n")
      )
    )
    expect(reformattedLines(files).size).toBe(0)
  })
})
