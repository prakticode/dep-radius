import { describe, expect, it } from "vitest"

import { judge, resultOf } from "../src/check.ts"
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
      evidence: [
        {
          package: "zod",
          onSite: ["src/a.ts:4"],
          options: [],
          types: [],
          names: [],
        },
      ],
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
      { package: "zod", onSite: [], options: [], types: [], names: ["coerce"] },
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

  it("supports a case whose expected line is an option key or an imported type", () => {
    const out = judge(base, {
      zod: {
        names: [],
        sites: [],
        options: ["src/a.ts:4"],
        types: ["src/a.ts:4", "src/a.ts:8"],
      },
    })
    expect(out.evidence).toEqual([
      {
        package: "zod",
        onSite: [],
        options: ["src/a.ts:4"],
        types: ["src/a.ts:4"],
        names: [],
      },
    ])
  })
})

describe("resultOf", () => {
  it("calls a case a reformat when most expected lines only changed layout, whatever else", () => {
    expect(resultOf({ weak: false }, { expectedReformatShare: 0.8 })).toBe(
      "reformat"
    )
    expect(resultOf({ weak: false }, { expectedReformatShare: 0.2 })).toBe(
      "supported"
    )
    expect(resultOf({ weak: true }, { expectedReformatShare: 0 })).toBe("weak")
  })
})
