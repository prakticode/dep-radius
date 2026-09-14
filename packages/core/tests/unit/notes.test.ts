import { describe, expect, it } from "vitest"

import { splitEntries } from "../../src/notes/entries.ts"
import { parseRepository } from "../../src/notes/repo-url.ts"
import { changelogSections } from "../../src/notes/changelog.ts"
import { isCodeShaped, matchNotes } from "../../src/notes/match.ts"
import { isPointerOnly, prereleasesIn } from "../../src/notes/collect.ts"

describe("changelogSections", () => {
  it("reads ATX headings in their common spellings", () => {
    const s = changelogSections(
      `# Changelog\n\n## [2.1.0] - 2026-01-02\n\n- b\n\n## v2.0.0\n\n### Major Changes\n\n- a\n\n## pkg@1.9.0\n\n- c\n`
    )
    expect([...s.keys()]).toEqual(["2.1.0", "2.0.0", "1.9.0"])
    expect(s.get("2.0.0")).toContain("### Major Changes")
  })

  it("reads setext headings, the express History.md shape", () => {
    const s = changelogSections(
      `4.21.2 / 2024-11-06\n==================\n\n  * deps: path-to-regexp@0.1.12\n\n4.21.1 / 2024-10-08\n==================\n\n  * Backport a fix\n`
    )
    expect([...s.keys()]).toEqual(["4.21.2", "4.21.1"])
    expect(s.get("4.21.1")).toBe("* Backport a fix")
  })
})

describe("splitEntries", () => {
  it("splits bullets, headed sections and keeps code apart", () => {
    const e = splitEntries(
      "4.6.0",
      [
        "At a glance:",
        "",
        "- [`.validate()`](https://x) — checks validity",
        "",
        "## Bug fixes",
        "",
        "### ⚠️ The email pattern dropped its lookaheads",
        "",
        "`v.email()` is stricter.",
        "",
        "```ts",
        "v.email().parse(x)",
        "```",
        "",
        "## `.validate()`",
        "",
        "Standalone boolean validation.",
        "",
        "## Commits",
        "",
        "- abc1234 ci: faster (#6569)",
        "- def5678 fix: email (#6532)",
      ].join("\n")
    )
    const titles = e.map((x) => x.title)
    expect(titles).toContain("⚠️ The email pattern dropped its lookaheads")
    // the glance bullet restates the ".validate()" section
    expect(titles.filter((t) => t.startsWith(".validate()"))).toEqual([
      ".validate()",
    ])
    const email = e.find((x) => x.title.includes("email pattern"))!
    expect(email.breakingMarker).toBe(true)
    expect(email.regions.map((r) => r.kind)).toEqual([
      "title",
      "inline-code",
      "prose",
      "code-block",
    ])
    expect(
      e.filter((x) => x.headingPath.includes("Commits")).every((x) => x.noise)
    ).toBe(true)
  })

  it("marks breaking only where a heading or a title says so", () => {
    const e = splitEntries(
      "1.0.0",
      "- Adds a non-breaking option, nothing breaking here\n- BREAKING CHANGE: drop Node 18\n\n## Breaking changes\n\n- `foo()` removed\n"
    )
    expect(e.map((x) => x.breakingMarker)).toEqual([false, true, true])
  })

  it("marks a title that leads with breaking in any emphasis", () => {
    const e = splitEntries(
      "13.0.0",
      "### Changed\n\n- *Breaking*: excess command-arguments cause an error by default\n- _Breaking_: throw on unsupported option flags\n- __Breaking:__ drop Node 18\n- *Improved* help output\n"
    )
    expect(e.map((x) => x.breakingMarker)).toEqual([true, true, true, false])
  })
})

describe("matchNotes", () => {
  const entries = splitEntries(
    "2.0.0",
    [
      "- The `email()` pattern changed",
      "- Improved email deliverability docs",
      "- `safeParse` returns a frozen result",
      "- Add `v.iban()`",
      "- BREAKING CHANGE: drop Node 18",
      "- BREAKING CHANGE: `v.emoji()` rejects component strings",
    ].join("\n")
  )

  it("matches plain words only when written as code, code-shaped names anywhere", () => {
    expect(isCodeShaped("safeParse")).toBe(true)
    expect(isCodeShaped("email")).toBe(false)
    const m = matchNotes(entries, ["email", "safeParse"], [])
    expect(m.matched.map((x) => x.entry.title)).toEqual([
      "The email() pattern changed",
      "safeParse returns a frozen result",
    ])
    expect(m.matched.every((x) => x.direct)).toBe(true)
  })

  it("keeps breaking notes that name no API, drops those about an API you do not use", () => {
    const m = matchNotes(entries, ["email"], [])
    expect(m.unattributedBreaking.map((x) => x.title)).toEqual([
      "BREAKING CHANGE: drop Node 18",
    ])
  })

  it("never matches a weak plain word from example code alone", () => {
    const code = splitEntries(
      "1.0.0",
      "### New thing\n\n```ts\nres.redirect('/x')\n```\n"
    )
    expect(matchNotes(code, [], ["redirect"]).matched).toEqual([])
    const inline = splitEntries("1.0.0", '- Deprecate `res.redirect("back")`\n')
    expect(matchNotes(inline, [], ["redirect"]).matched[0]?.direct).toBe(false)
  })

  it("demotes names that sit in the examples of many entries", () => {
    const many = splitEntries(
      "1.0.0",
      [
        "### A",
        "```ts\nv.object({})\n```",
        "### B",
        "```ts\nv.object({})\n```",
        "### C",
        "```ts\nv.object({})\n```",
        "### D",
        "```ts\nv.string()\n```",
      ].join("\n\n")
    )
    expect(matchNotes(many, ["object"], []).matched).toEqual([])
  })
})

describe("matchNotes with the options of calls you make", () => {
  const entries = splitEntries(
    "8.0.0",
    [
      "- Default `quiet` to false",
      "- The quiet flag is gone from the docs",
      "- changed `returnNull` default to `false`",
      "- **Breaking:** `Strict-Transport-Security` now has a max-age of 365 days",
      "- `path: string[]` is accepted",
      "- `h` and `s` values are rounded",
      "- Fix handling of uppercase `retry.methods`",
      "### Examples",
      "```js\nconfig({ quiet: true })\n```",
    ].join("\n")
  )
  const titles = (accepted: string[], strong: string[] = []) =>
    matchNotes(entries, strong, [], { accepted }).matched.map((m) => [
      m.entry.title,
      m.hits.map((h) => `${h.name}${h.option ? " (option)" : ""}`),
    ])

  it("matches an option as a code span, a code-shaped word or the header it sets", () => {
    expect(
      titles(["quiet", "returnNull", "strictTransportSecurity", "path"])
    ).toEqual([
      [
        "**Breaking:** Strict-Transport-Security now has a max-age of 365 days",
        ["strictTransportSecurity (option)"],
      ],
      ["Default quiet to false", ["quiet (option)"]],
      ["changed returnNull default to false", ["returnNull (option)"]],
      ["path: string[] is accepted", ["path (option)"]],
    ])
    expect(titles(["retry"])).toEqual([
      ["Fix handling of uppercase retry.methods", ["retry (option)"]],
    ])
  })

  it("never matches an option from prose words, examples or a single letter", () => {
    expect(titles(["flag", "config", "h", "s"])).toEqual([])
  })

  it("leaves a name the code uses to the usual rules", () => {
    expect(titles(["quiet"], ["quiet"])).toEqual([])
  })
})

describe("matchNotes with commit titles", () => {
  it("reads a title that starts with the API it changes as naming it", () => {
    const entries = splitEntries(
      "7.7.0",
      [
        "- d588e37 #755 diff: fix prerelease to stable version diff logic",
        "- fix(inc): validate identifiers",
        "- fix: diff docs",
        "- gt: faster",
      ].join("\n")
    )
    const m = matchNotes(entries, ["diff", "inc", "gt"], [])
    expect(
      m.matched.map((x) => [x.entry.title, x.hits.map((h) => h.name)])
    ).toEqual([
      [
        "d588e37 #755 diff: fix prerelease to stable version diff logic",
        ["diff"],
      ],
      ["fix(inc): validate identifiers", ["inc"]],
    ])
  })
})

describe("parseRepository", () => {
  it("reads every common form", () => {
    expect(
      parseRepository("git+https://github.com/acme/schemakit.git")
    ).toMatchObject({ owner: "acme", repo: "schemakit" })
    expect(
      parseRepository({
        url: "git+ssh://git@github.com/vercel/next.js.git",
        directory: "packages/next",
      })
    ).toMatchObject({
      owner: "vercel",
      repo: "next.js",
      directory: "packages/next",
    })
    expect(parseRepository("github:a/b")).toMatchObject({
      owner: "a",
      repo: "b",
    })
    expect(
      parseRepository("https://github.com/o/r/tree/main/packages/x")
    ).toMatchObject({ directory: "packages/x" })
    expect(parseRepository("https://gitlab.com/o/r")?.host).toBe("other")
  })
})

describe("isPointerOnly", () => {
  it("reads a body that only points elsewhere as no notes", () => {
    expect(
      isPointerOnly(
        "**Change log available at https://docs.example.com/changelog**"
      )
    ).toBe(true)
    expect(
      isPointerOnly(
        "**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.1.0"
      )
    ).toBe(true)
    expect(
      isPointerOnly(
        "See [CHANGELOG.md](https://github.com/o/r/blob/main/CHANGELOG.md) for details."
      )
    ).toBe(true)
    expect(isPointerOnly("<!-- generated -->\n")).toBe(true)
  })

  it("keeps a body that says something", () => {
    expect(
      isPointerOnly(
        "- Fix `parse()` on empty input (#12)\n\n**Full Changelog**: https://github.com/o/r/compare/v1...v2"
      )
    ).toBe(false)
    expect(
      isPointerOnly(
        "## What's Changed\n* Drop Node 18 by @a in https://github.com/o/r/pull/3"
      )
    ).toBe(false)
  })
})

describe("prereleasesIn", () => {
  it("reads the betas and release candidates of versions in range, never canaries", () => {
    const versions = [
      "5.2.4",
      "6.0.0-beta.0",
      "6.0.0-beta.2",
      "6.0.0-rc.1",
      "6.0.0",
      "6.1.0-canary.20260101",
      "7.0.0-beta.0",
    ]
    const p = {
      name: "x",
      "dist-tags": {},
      time: {},
      versions: Object.fromEntries(
        versions.map((v) => [v, { version: v, dist: { tarball: "" } }])
      ),
    }
    expect(prereleasesIn(p, ["6.0.0", "6.1.0"])).toEqual([
      "6.0.0-beta.0",
      "6.0.0-beta.2",
      "6.0.0-rc.1",
    ])
  })
})

describe("demotion and breaking entries", () => {
  it("never silences a breaking entry, even when its only link is example code", () => {
    const many = splitEntries(
      "1.0.0",
      [
        "### A",
        "```ts\nv.object({})\n```",
        "### B",
        "```ts\nv.object({})\n```",
        "### ⚠️ Record keys changed",
        "```ts\nv.object({})\n```",
      ].join("\n\n")
    )
    expect(
      matchNotes(many, ["object"], []).matched.map((m) => m.entry.title)
    ).toEqual(["⚠️ Record keys changed"])
  })
})
