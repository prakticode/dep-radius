import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, writeFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { run } from "../../src/run.ts"
import type { PackageBrief } from "../../src/model.ts"
import { splitEntries } from "../../src/notes/entries.ts"
import { recordFileName } from "../../src/records/load.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import { type ChangeRecord, RECORD_SCHEMA } from "../../src/records/record.ts"
import { FakeRegistry, testCtx, testOptions } from "../helpers/fake-registry.ts"

const NAME = "acme-watcher"
const NOTES = [
  "- Remove glob support",
  "- Closing twice no longer throws",
  "- Paths are compared case-insensitively on macOS",
].join("\n")
const TYPES = `export interface WatchOptions { glob?: boolean; depth?: number }
export declare function watch(path: string, options?: WatchOptions): void
export declare function unwatch(path: string): void
`

function version(v: string) {
  return {
    version: v,
    publishedAt: "2026-08-01T00:00:00Z",
    files: {
      "package.json": JSON.stringify({
        name: NAME,
        version: v,
        types: "index.d.ts",
      }),
      "index.js": "module.exports = {}",
      "index.d.ts": TYPES,
    },
  }
}

describe("run with change records from a directory", () => {
  let cleanup: () => void
  const briefs: Record<string, PackageBrief> = {}

  beforeAll(async () => {
    const [glob, closing] = splitEntries("2.0.0", NOTES)
    const record = (id: string, subjects: string[]): ChangeRecord => ({
      schema: RECORD_SCHEMA,
      entry: id,
      version: "2.0.0",
      kind: "change",
      breaking: false,
      subjects,
      what: "",
      source: "ai",
      extractor: "ai:test:1",
    })
    const recordsDir = mkdtempSync(join(tmpdir(), "radius-records-"))
    writeFileSync(
      join(recordsDir, recordFileName(NAME, "2.0.0")),
      JSON.stringify([
        // an API that does not exist is dropped, the real one stays
        record(glob!.id, [`${NAME}:watch{glob}`, `${NAME}:globby`]),
        record(closing!.id, [`${NAME}:unwatch`]),
        { ...record(closing!.id, [`${NAME}:watch`]), schema: 99 },
      ])
    )
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "app",
          private: true,
          dependencies: { [NAME]: "^1.0.0" },
        }),
        [`node_modules/${NAME}/package.json`]: JSON.stringify({
          name: NAME,
          version: "1.0.0",
        }),
        "src/watch.ts": `import { watch } from "${NAME}"\n\nwatch("src", { depth: 1 })\n`,
      },
    })
    cleanup = project.cleanup
    for (const [label, extra] of [
      ["rules", {}],
      ["records", { recordsDir }],
    ] as const) {
      const registry = new FakeRegistry([
        {
          name: NAME,
          repository: "git+https://github.com/acme/watcher.git",
          versions: [version("1.0.0"), version("2.0.0")],
          releases: { "v2.0.0": NOTES },
        },
      ])
      const opts = testOptions(project.root, {
        specs: [`${NAME}@2.0.0`],
        ...extra,
      })
      const brief = await run(opts, testCtx(opts, registry))
      briefs[label] = brief.packages[0]!
    }
  })

  afterAll(() => cleanup())

  it("leaves every note unplaced with the rules alone", () => {
    const p = briefs.rules!
    expect(p.notes.matched).toEqual([])
    expect(p.notes.unattributedChanges).toHaveLength(3)
  })

  it("ties a record's subject to the lines that reach it", () => {
    const p = briefs.records!
    expect(
      p.notes.matched.map((m) => [m.entry.title, m.hits.map((h) => h.subject)])
    ).toEqual([["Remove glob support", [`${NAME}:watch{glob}`]]])
    expect(p.usage.byName.glob?.map((s) => `${s.file}:${s.line}`)).toEqual([
      "src/watch.ts:3",
    ])
  })

  it("keeps a note about an API the code never reaches unplaced", () => {
    const p = briefs.records!
    expect(p.notes.unattributedChanges.map((e) => e.title)).toEqual([
      "Closing twice no longer throws",
      "Paths are compared case-insensitively on macOS",
    ])
    expect(p.verdict).toBe("review")
  })
})
