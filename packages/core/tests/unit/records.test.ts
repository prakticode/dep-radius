import { describe, expect, it } from "vitest"

import { matchNotes } from "../../src/notes/match.ts"
import { joinRecords } from "../../src/records/join.ts"
import { splitEntries } from "../../src/notes/entries.ts"
import { rulesRecords } from "../../src/records/rules.ts"

const entries = splitEntries(
  "3.0.0",
  [
    "- The `email()` pattern changed",
    "- Default `quiet` to false",
    "- fix(storage): avoid a second write",
    "- BREAKING CHANGE: drop Node 18",
    "### ⚠️ Record keys changed",
    "```ts\nv.object({})\n```",
  ].join("\n")
)

describe("rules records", () => {
  it("say which names an entry writes and where, as plain data", () => {
    const records = rulesRecords(entries, {
      names: ["email", "object", "storage"],
      options: ["quiet"],
    })
    expect(
      records.map((r) => [r.what, r.breaking, r.namesApi, r.mentions])
    ).toEqual([
      [
        "The email() pattern changed",
        false,
        "headline",
        [{ name: "email", regions: ["inline-code"] }],
      ],
      [
        "Default quiet to false",
        false,
        "headline",
        [{ name: "quiet", regions: ["inline-code"], option: true }],
      ],
      [
        "fix(storage): avoid a second write",
        false,
        "none",
        [{ name: "storage", regions: [], scope: true }],
      ],
      ["BREAKING CHANGE: drop Node 18", true, "none", []],
      [
        "⚠️ Record keys changed",
        true,
        "none",
        [{ name: "object", regions: ["code-block"] }],
      ],
    ])
  })

  it("join to the same result after a round trip through JSON", () => {
    const records = rulesRecords(entries, {
      names: ["email", "object"],
      options: ["quiet"],
    })
    const use = {
      strong: ["email"],
      weak: ["object"],
      accepted: ["quiet"],
      typesRead: true,
    }
    const joined = joinRecords(
      entries,
      JSON.parse(JSON.stringify(records)) as typeof records,
      use
    )
    expect(joined).toEqual(
      matchNotes(entries, ["email"], ["object"], { accepted: ["quiet"] })
    )
    expect(joined.matched.map((m) => m.hits.map((h) => h.name))).toEqual([
      ["email"],
      ["quiet"],
    ])
  })
})
