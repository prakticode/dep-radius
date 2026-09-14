import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, writeFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { matchNotes } from "../../src/notes/match.ts"
import { splitEntries } from "../../src/notes/entries.ts"
import { rulesRecords } from "../../src/records/rules.ts"
import { validateRecords } from "../../src/records/validate.ts"
import { joinRecords, subjectSites } from "../../src/records/join.ts"
import { loadRecords, recordFileName } from "../../src/records/load.ts"
import type { NoteEntry, Surface, SurfaceSymbol } from "../../src/model.ts"
import { type ChangeRecord, RECORD_SCHEMA } from "../../src/records/record.ts"

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

const surface = (
  version: string,
  symbols: Record<string, Partial<SurfaceSymbol>>
): Surface => ({
  pkg: "lib",
  version,
  integrity: `sha512-${version}`,
  ts: "6.0.0",
  algo: 1,
  typesFrom: "package",
  entries: { ".": { typesFile: "index.d.ts", exportEquals: false } },
  symbols: Object.fromEntries(
    Object.entries(symbols).map(([path, s]) => [
      path,
      { path, kind: "function", sig: [], deprecated: false, ...s },
    ])
  ),
  flags: [],
})

const aiRecord = (entry: NoteEntry, subjects: string[]): ChangeRecord => ({
  schema: RECORD_SCHEMA,
  entry: entry.id,
  version: entry.version,
  kind: entry.kind,
  breaking: entry.breakingMarker,
  subjects,
  what: entry.title,
  source: "ai",
  extractor: "ai:test:1",
})

const site = { file: "src/a.ts", line: 3, col: 1, typeOnly: false, text: "" }

describe("records from outside the run", () => {
  const notes = splitEntries(
    "4.0.0",
    [
      "- Remove glob support",
      "- Option [strict](https://x) controls all strict mode restrictions",
      "- Queries that are not subscribed no longer refetch",
      "- BREAKING CHANGE: the parser is rewritten",
    ].join("\n")
  )
  const [glob, strict, subscribed, rewritten] = notes as [
    NoteEntry,
    NoteEntry,
    NoteEntry,
    NoteEntry,
  ]
  const from = surface("3.0.0", {
    "lib:watch": {},
    "lib:Parser": { kind: "class", options: ["strict"] },
    "lib:unwatch": {},
  })
  const to = surface("4.0.0", {
    "lib:watch": {},
    "lib:Parser": { kind: "class", options: ["strict", "subscribed"] },
  })

  it("keep only subjects in either version's types, for these notes only", () => {
    const valid = validateRecords(
      [
        aiRecord(glob, ["lib:watch", "lib:glob"]),
        aiRecord(strict, ["lib:Parser{strict}", "lib:Parser{loose}"]),
        aiRecord(subscribed, ["lib:unwatch", "lib:Parser{subscribed}"]),
        { ...aiRecord(glob, ["lib:watch"]), entry: "not-an-entry" },
        { ...aiRecord(glob, ["lib:watch"]), version: "3.9.0" },
      ],
      notes,
      { from, to }
    )
    expect(valid.map((r) => [r.what, r.subjects])).toEqual([
      ["Remove glob support", ["lib:watch"]],
      [
        "Option strict controls all strict mode restrictions",
        ["lib:Parser{strict}"],
      ],
      [
        "Queries that are not subscribed no longer refetch",
        ["lib:Parser{subscribed}", "lib:unwatch"],
      ],
    ])
  })

  it("tie a note to the code that reaches its subject, and never place one elsewhere", () => {
    const m = matchNotes(notes, ["watch"], [], {
      records: [
        aiRecord(glob, ["lib:watch"]),
        aiRecord(strict, ["lib:Parser{strict}"]),
        aiRecord(subscribed, ["lib:unwatch"]),
        aiRecord(rewritten, ["lib:unwatch"]),
      ],
      paths: { "lib:watch": [site], "lib:Parser#parse": [site] },
    })
    expect(
      m.matched.map((x) => [
        x.entry.title,
        x.direct,
        x.hits.map((h) => `${h.name} ${h.subject}`),
      ])
    ).toEqual([
      ["Remove glob support", false, ["watch lib:watch"]],
      [
        "Option strict controls all strict mode restrictions",
        false,
        ["strict lib:Parser{strict}"],
      ],
    ])
    // about an API the code never reaches: still a change radius cannot place, never quiet
    expect(m.unattributedChanges.map((e) => e.title)).toEqual([
      "Queries that are not subscribed no longer refetch",
    ])
    // nor a break that could apply to anyone
    expect(m.unattributedBreaking.map((e) => e.title)).toEqual([
      "BREAKING CHANGE: the parser is rewritten",
    ])
    expect(subjectSites(m.matched, { "lib:Parser#parse": [site] })).toEqual({
      strict: [site],
    })
  })

  it("tie by name without types", () => {
    const m = matchNotes(notes, ["watch", "Parser"], [], {
      typesRead: false,
      records: [
        aiRecord(glob, ["lib:watch"]),
        aiRecord(strict, ["lib:Parser{strict}"]),
        aiRecord(subscribed, ["lib:unwatch"]),
      ],
    })
    // the option nobody passes lands on the calls of what takes it
    expect(
      m.matched.map((x) => [x.entry.title, x.hits.map((h) => h.name)])
    ).toEqual([
      ["Remove glob support", ["watch"]],
      ["Option strict controls all strict mode restrictions", ["Parser"]],
    ])
    expect(m.unattributedChanges.map((e) => e.title)).toEqual([
      "Queries that are not subscribed no longer refetch",
    ])
  })

  it("load from <name>@<version>.json, ignoring other schemas, in a stable order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radius-records-"))
    const a = aiRecord(strict, ["lib:Parser{strict}", "lib:Parser{strict}"])
    const b = aiRecord(glob, ["lib:watch"])
    writeFileSync(
      join(dir, recordFileName("@scope/lib", "4.0.0")),
      JSON.stringify([
        a,
        { ...b, schema: 2 },
        b,
        b,
        { ...b, version: "3.0.0" },
        "not a record",
      ])
    )
    writeFileSync(join(dir, recordFileName("@scope/lib", "3.0.0")), "{oops")
    expect(recordFileName("@scope/lib", "4.0.0")).toBe("@scope__lib@4.0.0.json")
    const loaded = await loadRecords(dir, "@scope/lib", ["4.0.0", "3.0.0"])
    const expected = [{ ...a, subjects: ["lib:Parser{strict}"] }, b].sort(
      (x, y) => (x.entry < y.entry ? -1 : 1)
    )
    expect(loaded).toEqual(expected)
    expect(await loadRecords(dir, "other", ["4.0.0"])).toEqual([])
  })
})
