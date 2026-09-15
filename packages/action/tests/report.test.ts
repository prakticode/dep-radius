import { describe, expect, it } from "vitest"

import {
  commentBody,
  MARKER,
  parseFailOn,
  planComment,
  shouldFail,
  summaryBody,
  verdictOf,
} from "../src/report.ts"

describe("verdictOf", () => {
  it("takes the worst verdict, and none when no dependency changed", () => {
    expect(verdictOf({ packages: [] })).toBe("none")
    expect(verdictOf({ packages: [{ verdict: "quiet" }] })).toBe("quiet")
    expect(
      verdictOf({ packages: [{ verdict: "quiet" }, { verdict: "review" }] })
    ).toBe("review")
    expect(
      verdictOf({ packages: [{ verdict: "review" }, { verdict: "blocked" }] })
    ).toBe("blocked")
  })
})

describe("fail-on", () => {
  it("defaults to blocked and refuses anything else", () => {
    expect(parseFailOn("")).toBe("blocked")
    expect(parseFailOn(" review ")).toBe("review")
    expect(() => parseFailOn("quiet")).toThrow("fail-on must be")
  })

  it("fails on blocked unless never, and on review only when asked", () => {
    expect(shouldFail("blocked", "blocked")).toBe(true)
    expect(shouldFail("review", "blocked")).toBe(false)
    expect(shouldFail("review", "review")).toBe(true)
    expect(shouldFail("quiet", "review")).toBe(false)
    expect(shouldFail("none", "review")).toBe(false)
    expect(shouldFail("blocked", "never")).toBe(false)
  })
})

describe("the pull request comment", () => {
  const brief = commentBody("### radius\n\nbody\n", "0.2.0")

  it("starts with the marker, so the next push edits it instead of adding one", () => {
    expect(brief.startsWith(`${MARKER}\n### radius`)).toBe(true)
    expect(
      planComment(
        [
          { id: 1, body: "lgtm" },
          { id: 2, body: brief },
        ],
        "quiet"
      )
    ).toEqual({ kind: "update", id: 2 })
  })

  it("stays silent on a pull request that changes no dependency", () => {
    expect(planComment([{ id: 1, body: null }], "none")).toEqual({
      kind: "skip",
    })
    expect(planComment([], "review")).toEqual({ kind: "create" })
  })

  it("ends with one line that says what radius is and how to add it", () => {
    const lines = brief.trimEnd().split("\n")
    expect(lines.at(-2)).toBe("")
    expect(lines.at(-1)).toBe(
      "<sub>[dep-radius](https://github.com/prakticode/dep-radius) 0.2.0 matches release notes to the lines they affect · [Add it to your repo](https://depradius.com/docs/github-action) · updated on every push</sub>"
    )
    expect(brief.endsWith("</sub>\n")).toBe(true)
  })

  it("still finds and edits a comment written with the earlier footer", () => {
    const old = `${MARKER}\n### radius\n\n<sub>[dep-radius](https://github.com/prakticode/dep-radius) 0.1.0, updated on every push</sub>\n`
    expect(planComment([{ id: 3, body: old }], "review")).toEqual({
      kind: "update",
      id: 3,
    })
  })

  it("edits an earlier comment even once no dependency changes any more", () => {
    expect(planComment([{ id: 7, body: brief }], "none")).toEqual({
      kind: "update",
      id: 7,
    })
  })
})

describe("the job summary", () => {
  it("carries the same footer, without the marker or the promise to update", () => {
    const summary = summaryBody("### radius\n\nbody\n\n", "0.2.0")
    expect(summary.startsWith(MARKER)).toBe(false)
    expect(summary).toBe(
      "### radius\n\nbody\n\n<sub>[dep-radius](https://github.com/prakticode/dep-radius) 0.2.0 matches release notes to the lines they affect · [Add it to your repo](https://depradius.com/docs/github-action)</sub>\n"
    )
  })
})
