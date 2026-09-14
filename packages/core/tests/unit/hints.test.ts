import { describe, expect, it } from "vitest"

import { codeNames } from "../../src/notes/code-names.ts"
import type { NoteEntry, PackageUsage, RawRef } from "../../src/model.ts"
import {
  buildImplementationFacts,
  DEFAULT_LIMITS,
  diffImplementations,
  HINT_CHANGED_SHARE,
  type ImplementationFacts,
  linkHints,
} from "../../src/facts/implementation/index.ts"

function entry(title: string, regions: NoteEntry["regions"] = []): NoteEntry {
  return {
    id: title,
    version: "1.0.1",
    title,
    headingPath: [],
    regions: [{ kind: "title", text: title }, ...regions],
    breakingMarker: false,
    noise: false,
    kind: "change",
    refs: [],
  }
}

describe("codeNames", () => {
  it("reads code spans, code-shaped words and commit scopes, never plain words", () => {
    expect(
      codeNames(
        entry("fix(storage): avoid calling setItem with the state", [
          { kind: "inline-code", text: "persist(options)" },
        ])
      )
    ).toEqual(["options", "persist", "setItem", "storage"])
    expect(codeNames(entry("**throttle:** handle default values"))).toEqual([
      "throttle",
    ])
    expect(codeNames(entry("diff: fix prerelease to stable"))).toEqual(["diff"])
    expect(codeNames(entry("Fix a crash when the state is empty"))).toEqual([])
  })
})

function facts(code: string, version: string): ImplementationFacts {
  const r = buildImplementationFacts(
    "lib",
    version,
    "sha512-x",
    new Map([
      ["package.json", Buffer.from(JSON.stringify({ main: "index.js" }))],
      ["index.js", Buffer.from(code)],
    ]),
    "require",
    DEFAULT_LIMITS
  )
  if (!r.ok) throw new Error(r.reason)
  return r.facts
}

function usage(...names: string[]): PackageUsage {
  const refs: RawRef[] = names.map((imported, i) => ({
    installedId: "lib",
    pkg: "lib",
    specifier: "lib",
    entry: ".",
    binding: { kind: "named", imported },
    chain: [],
    callSelf: true,
    site: { file: "a.js", line: i + 1, col: 1, typeOnly: false, text: "" },
  }))
  return {
    installedId: "lib",
    pkg: "lib",
    refs,
    strongNames: names,
    weakNames: [],
    files: 1,
    opaque: [],
    blindSpots: [],
  }
}

const lib = (save: string, others = "") => `
function save(s, v) { ${save} }
function load(s) { return s.getItem("k") }
function a() { ${others} }
function b() {}
function c() {}
module.exports = { save, load, a, b, c }
`

function hints(before: string, after: string, used: string[], notes: string[]) {
  const from = facts(before, "1.0.0")
  const to = facts(after, "1.0.1")
  return linkHints({
    pkg: "lib",
    usage: usage(...used),
    from,
    to,
    diff: diffImplementations(from, to),
    entries: notes.map((n) => entry(n)),
  })
}

describe("linkHints", () => {
  it("links a note naming what a changed unit calls to the used export", () => {
    const r = hints(
      lib(`s.setItem("k", v)`),
      lib(`if (v !== undefined) s.setItem("k", v)`),
      ["save", "load"],
      ["Skip setItem for undefined values", "Faster getItem"]
    )
    expect(r.status).toBe("computed")
    if (r.status !== "computed") return
    expect([...r.hints.entries()]).toEqual([
      [
        "Skip setItem for undefined values",
        [
          {
            export: "lib:save",
            via: ["setItem"],
            sites: [expect.objectContaining({ line: 1 })],
          },
        ],
      ],
    ])
  })

  it("says nothing for an export the project does not use", () => {
    const r = hints(
      lib(`s.setItem("k", v)`),
      lib(`if (v) s.setItem("k", v)`),
      ["load"],
      ["Skip setItem for undefined values"]
    )
    expect(r.status === "computed" && r.hints.size).toBe(0)
  })

  it(`turns off past ${HINT_CHANGED_SHARE * 100}% of changed exports`, () => {
    const r = hints(
      lib(`s.setItem("k", v)`),
      lib(`if (v) s.setItem("k", v)`, "return 1"),
      ["save"],
      ["Skip setItem for undefined values"]
    )
    expect(r.status).toBe("too-many-changed")
  })
})
