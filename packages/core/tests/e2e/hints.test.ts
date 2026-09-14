import { join } from "node:path"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { run } from "../../src/run.ts"
import { validate } from "../helpers/json-schema.ts"
import type { Brief, PackageBrief } from "../../src/model.ts"
import { renderMarkdown } from "../../src/render/markdown.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import { type BriefV1, renderJson } from "../../src/render/json.ts"
import {
  type FakePackage,
  FakeRegistry,
  testCtx,
  testOptions,
} from "../helpers/fake-registry.ts"

// A store whose `persist` stops writing back what it just read. The note names `setItem`, which the
// project never calls: only the package's code ties the note to the `persist` call.
const store = (hydrate: string, shared = "return x") => `
function helper(x) { ${shared} }
function createStore(init) { return { state: helper(init()) } }
function persist(init, options) {
  const storage = options.storage
  function hydrate() {
    ${hydrate}
  }
  hydrate()
  return init
}
function devtools(f) { return f }
function combine(a, b) { return Object.assign({}, a, b) }
function redux(reducer) { return reducer }
module.exports = { createStore, persist, devtools, combine, redux }
`

const BEFORE = `const value = storage.getItem(options.name)
    storage.setItem(options.name, value)
    return value`
const AFTER = `return storage.getItem(options.name)`

const NOTES = `## What's Changed
* fix(storage): avoid calling setItem with the state just retrieved (#12)
* Rename the \`redux\` action type for devtools (#13)
`

function pkg(name: string, before: string, after: string): FakePackage {
  const files = (code: string, version: string) => ({
    "package.json": JSON.stringify({ name, version, main: "index.js" }),
    "index.js": code,
  })
  return {
    name,
    repository: `git+https://github.com/acme/${name}.git`,
    versions: [
      {
        version: "1.0.0",
        publishedAt: "2026-08-01T00:00:00Z",
        files: files(before, "1.0.0"),
      },
      {
        version: "1.0.1",
        publishedAt: "2026-09-01T00:00:00Z",
        files: files(after, "1.0.1"),
      },
    ],
    releases: { "v1.0.1": NOTES },
  }
}

async function briefFor(
  p: FakePackage
): Promise<{ brief: Brief; b: PackageBrief }> {
  const project = createProject({
    files: {
      "package.json": pkgJson({
        name: "app",
        private: true,
        dependencies: { [p.name]: "^1.0.0" },
      }),
      [`node_modules/${p.name}/package.json`]: JSON.stringify({
        name: p.name,
        version: "1.0.0",
      }),
      "src/store.js": `import { createStore, persist } from "${p.name}"\n\nexport const s = createStore(\n  persist(() => ({ id: 1 }), { name: "id", storage: localStorage })\n)\n`,
    },
  })
  try {
    const opts = testOptions(project.root)
    const brief = await run(opts, testCtx(opts, new FakeRegistry([p])))
    const out = brief.packages.find((x) => x.pkg === p.name)
    if (!out) throw new Error(JSON.stringify(brief.notAnalyzed))
    return { brief, b: out }
  } finally {
    project.cleanup()
  }
}

describe("code hints on notes radius cannot tie by name", () => {
  it("point a note naming an internal call at the export the project uses", async () => {
    const { brief, b } = await briefFor(
      pkg("acme-store", store(BEFORE), store(AFTER))
    )
    const note = b.notes.unattributedChanges.find((e) =>
      e.title.includes("setItem")
    )
    expect(note?.likely).toEqual([
      {
        export: "acme-store:persist",
        via: ["setItem"],
        sites: [expect.objectContaining({ file: "src/store.js", line: 4 })],
      },
    ])
    // `redux` is not used, and its code did not change
    const other = b.notes.unattributedChanges.find((e) =>
      e.title.includes("redux")
    )
    expect(other).toBeDefined()
    expect(other?.likely).toBeUndefined()

    const md = renderMarkdown(brief, Date.parse("2026-09-13T09:00:00Z"))
    expect(md).toContain(
      "probably reaches: src/store.js:4, via `setItem` inside `persist`"
    )
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../schema/brief-v1.schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    const json = JSON.parse(renderJson(brief)) as BriefV1
    expect(validate(json, schema)).toEqual([])
    expect(json.packages[0]?.notes.changesWithoutApi[0]?.likely?.[0]).toEqual(
      expect.objectContaining({
        export: "acme-store:persist",
        via: ["setItem"],
      })
    )
  })

  it("never change the verdict or move the note", async () => {
    const { b: hinted } = await briefFor(
      pkg("acme-store", store(BEFORE), store(AFTER))
    )
    const { b: plain } = await briefFor(
      pkg("acme-store", store(BEFORE), store(BEFORE))
    )
    expect(plain.notes.unattributedChanges.some((e) => e.likely)).toBe(false)
    expect(hinted.verdict).toBe(plain.verdict)
    expect(hinted.reasons).toEqual(plain.reasons)
    expect(hinted.notes.matched).toEqual(plain.notes.matched)
    expect(hinted.notes.unattributedChanges.map((e) => e.id)).toEqual(
      plain.notes.unattributedChanges.map((e) => e.id)
    )
  })

  it("stay off when most of what the project could use changed", async () => {
    // `createStore` changed too: 2 of the 5 exports, past the share where hints mean anything
    const { b } = await briefFor(
      pkg(
        "acme-core",
        store(BEFORE),
        store(`storage.setItem(options.name, 1)`, "return [x]")
      )
    )
    expect(b.notes.unattributedChanges.length).toBeGreaterThan(0)
    expect(b.notes.unattributedChanges.some((e) => e.likely)).toBe(false)
  })

  it("stay silent when the code cannot be read", async () => {
    const broken = pkg("acme-store", store(BEFORE), store(AFTER))
    broken.versions[1]!.files["index.js"] = "function ( {"
    const { b } = await briefFor(broken)
    expect(b.verdict).toBe("review")
    expect(b.notes.unattributedChanges.some((e) => e.likely)).toBe(false)
  })
})
