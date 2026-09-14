import { describe, expect, it } from "vitest"

import { judge } from "../src/check.ts"
import type { CaseManifest } from "../src/case.ts"

const base: Pick<CaseManifest, "expected" | "added" | "packages"> = {
  packages: [
    { name: "zod", from: "3.0.0", to: "4.0.0" },
    { name: "react", from: "18.0.0", to: "19.0.0" },
  ],
  expected: [
    {
      file: "src/a.ts",
      line: 4,
      text: "  const total = items.length",
      imports: ["zod"],
    },
  ],
  added: [{ file: "src/a.ts", line: 4, text: "  const total = count(items)" }],
}

describe("judge", () => {
  it("supports a case whose expected line is a use of the package", () => {
    const out = judge(base, {
      zod: { names: ["object"], sites: [{ file: "src/a.ts", line: 4 }] },
    })
    expect(out).toEqual({
      weak: false,
      evidence: [{ package: "zod", onSite: ["src/a.ts:4"], names: [] }],
    })
  })

  it("supports a case whose fix mentions a name the code uses from the package", () => {
    const out = judge(
      {
        ...base,
        added: [
          { file: "src/a.ts", line: 4, text: "  const total = z.coerce(x)" },
        ],
      },
      { zod: { names: ["coerce", "object"], sites: [] } }
    )
    expect(out.evidence).toEqual([
      { package: "zod", onSite: [], names: ["coerce"] },
    ])
  })

  it("marks a case weak when the fix touches nothing the code uses from the package", () => {
    const out = judge(base, {
      zod: {
        names: ["object", "length2"],
        sites: [{ file: "src/a.ts", line: 9 }],
      },
    })
    expect(out).toEqual({ weak: true, evidence: [] })
  })

  it("matches whole names only, and only for the package the file imports", () => {
    const out = judge(base, {
      zod: { names: ["len", "tota"], sites: [] },
      // react is upgraded too, but src/a.ts does not import it
      react: { names: ["items"], sites: [{ file: "src/a.ts", line: 4 }] },
    })
    expect(out.weak).toBe(true)
  })
})
