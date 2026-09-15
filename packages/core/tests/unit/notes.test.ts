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

  it("keeps the items nested under a bullet in that bullet", () => {
    const e = splitEntries(
      "15.0.0",
      [
        "### Changed",
        "- [breaking] `widget-it` => v6",
        "  - No fuzzy links by default.",
        "  - Unicode punctuation terminates the link by default.",
        "  - See [widget-it changelog](https://x/CHANGELOG.md)",
        "    for other changes.",
        "- Moved `validateLink` from properties",
        "  to prototype methods.",
      ].join("\n")
    )
    expect(e.map((x) => x.title)).toEqual([
      "[breaking] widget-it => v6",
      "Moved validateLink from properties",
    ])
    expect(e[0]!.breakingMarker).toBe(true)
    expect(
      e[0]!.regions.filter((r) => r.kind === "prose").map((r) => r.text)
    ).toEqual([
      "- No fuzzy links by default.",
      "- Unicode punctuation terminates the link by default.",
      "- See widget-it changelog",
      "for other changes.",
    ])
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

describe("changes nothing ties to the code", () => {
  const entries = splitEntries(
    "2.11.0",
    [
      "- Remove empty non-boolean attributes",
      "- fix(storage): avoid calling setItem with the state just retrieved",
      "- Add `allowedEmptyAttributes` option",
      "- feat: support async parsers",
      "- perf: faster merges",
      "- [Fix] ensure `arrayLimit` applies to [] notation as well",
      "- The `email()` pattern changed",
      "### Features",
      "- Brand new sanitizer engine",
    ].join("\n")
  )
  const titles = (typesRead: boolean) =>
    matchNotes(entries, ["email"], [], { typesRead }).unattributedChanges.map(
      (e) => e.title
    )

  it("keeps every change that names no API, but not additions or matches", () => {
    expect(titles(true)).toEqual([
      "Remove empty non-boolean attributes",
      "fix(storage): avoid calling setItem with the state just retrieved",
    ])
  })

  it("keeps a change naming an API it cannot place when the types were not read", () => {
    expect(titles(false)).toEqual([
      "Remove empty non-boolean attributes",
      "fix(storage): avoid calling setItem with the state just retrieved",
      "[Fix] ensure arrayLimit applies to [] notation as well",
    ])
  })
})

describe("entry kinds", () => {
  const kinds = (markdown: string) =>
    splitEntries("2.0.0", markdown).map((e) => [e.title, e.kind])

  it("reads the sentences a release opens with as an intro, install command included", () => {
    expect(
      kinds(
        [
          "Lib 2.0 is now available.",
          "",
          "```sh",
          "npm install lib@latest",
          "```",
          "",
          "At a glance:",
          "",
          "- Remove glob support",
          "- Add `watchFile()`",
        ].join("\n")
      )
    ).toEqual([
      ["Lib 2.0 is now available.", "intro"],
      ["Remove glob support", "change"],
      ["Add watchFile()", "addition"],
    ])
  })

  it("never reads a release made of one paragraph as an intro", () => {
    expect(kinds("Fixed the parser on empty input.")).toEqual([
      ["Fixed the parser on empty input.", "change"],
    ])
  })

  it("splits a labelled list into its items, and reads each item with its label", () => {
    const e = splitEntries(
      "5.0.0",
      [
        "* breaking:",
        "  * `res.status()` accepts only integers",
        "    * will throw a `RangeError` otherwise",
        "* deps: send@1.0.0",
        "* deps:",
        "  - content-type@^2.0.0",
        "- **types**:",
        "  - Wire RouteNamedMap via generated routes.d.ts",
      ].join("\n")
    )
    expect(e.map((x) => [x.title, x.kind, x.breakingMarker])).toEqual([
      ["res.status() accepts only integers", "change", true],
      ["deps: send@1.0.0", "housekeeping", false],
      ["content-type@^2.0.0", "housekeeping", false],
      ["Wire RouteNamedMap via generated routes.d.ts", "types", false],
    ])
    expect(e[0]!.regions.map((r) => r.text).join(" ")).toContain("RangeError")
  })

  it("reads work on the project itself, typings and pointers apart from changes", () => {
    expect(
      kinds(
        [
          "- 67e5478 #756 readme: added missing period",
          "- **docs:** Broken anchors (#1979)",
          "- Upgrade mocha version",
          "- Apply small linter fixes in tests",
          "- Special thanks to @someone for the help",
          "- TypeScript: add missing definition for `withMetadata`",
          "- improve typing for pipeline",
          "- ➡️ check out the migration guide",
          "- Fix migration CLI and cli tests",
          "- Backport: ci: add node.js 24 to test matrix",
        ].join("\n")
      )
    ).toEqual([
      ["67e5478 #756 readme: added missing period", "housekeeping"],
      ["**docs:** Broken anchors (#1979)", "housekeeping"],
      ["Upgrade mocha version", "housekeeping"],
      ["Apply small linter fixes in tests", "housekeeping"],
      ["Special thanks to @someone for the help", "housekeeping"],
      ["TypeScript: add missing definition for withMetadata", "types"],
      ["improve typing for pipeline", "types"],
      ["➡️ check out the migration guide", "reference"],
      ["Fix migration CLI and cli tests", "change"],
      ["Backport: ci: add node.js 24 to test matrix", "housekeeping"],
    ])
  })
})

describe("breaking sections", () => {
  it("keeps a breaking section that only mentions APIs in its text as a break for anyone", () => {
    const entries = splitEntries(
      "8.0.0",
      [
        "## Breaking changes",
        "",
        "Option strict controls all strict mode restrictions.",
        "Errors use `instancePath` instead of `dataPath`.",
      ].join("\n")
    )
    expect(
      matchNotes(entries, ["compile"], []).unattributedBreaking.map(
        (e) => e.title
      )
    ).toEqual(["Breaking changes"])
  })
})

describe("housekeeping", () => {
  it("reads project scopes, bracketed tags, thanks and bare links as housekeeping", () => {
    const e = splitEntries(
      "3.0.0",
      [
        "- fix(types): allow null for point values",
        "- [meta] add threat model",
        "- [Dev Deps] update `eslint`",
        "- Updated dependencies [abc1234]:",
        "- Thanks to Ada for the updates!",
        "- [npm](https://www.npmjs.com/package/x)",
        "- [#430]: #430",
        "- Fix the parser on empty input",
      ].join("\n")
    )
    expect(e.map((x) => [x.title, x.noise])).toEqual([
      ["fix(types): allow null for point values", true],
      ["[meta] add threat model", true],
      ["[Dev Deps] update eslint", true],
      ["Updated dependencies [abc1234]:", true],
      ["Thanks to Ada for the updates!", true],
      ["npm", true],
      ["[#430]: #430", true],
      ["Fix the parser on empty input", false],
    ])
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

describe("matchNotes with the packages behind an API", () => {
  const entries = splitEntries(
    "15.0.0",
    [
      "- [breaking] `widget-it` => v6",
      "  - No fuzzy links by default.",
      "- Bumped `path-to-regexp` to 8.0.0",
      "- Replaced widget-it with a faster parser",
      "- `widget-it --fuzzy` is the default",
    ].join("\n")
  )
  const titles = (weak: string[]) =>
    matchNotes(entries, [], weak).matched.map((m) => m.entry.title)

  it("ties a package named as code to the member named after it", () => {
    expect(titles(["widget"])).toEqual(["[breaking] widget-it => v6"])
  })

  it("never ties a longer package name, one in plain words or in a command", () => {
    expect(titles(["path", "to"])).toEqual([])
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
