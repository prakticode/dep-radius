import { join } from "node:path"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { run } from "../../src/run.ts"
import { validate } from "../helpers/json-schema.ts"
import { renderMarkdown } from "../../src/render/markdown.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import { type BriefV1, renderJson } from "../../src/render/json.ts"
import {
  type FakePackage,
  FakeRegistry,
  testCtx,
  testOptions,
} from "../helpers/fake-registry.ts"

// A package that exported one namespace, `export = acme`, and now exports plain functions. Its notes
// say so in words only: "Remove Deprecated Legacy Namespace Support".
const NAMESPACE = `declare namespace acme {
  interface Auth { verify(token: string): string }
  function auth(): Auth
  const apps: string[]
  namespace credential { function cert(path: string): object }
  function initializeApp(options?: object): void
}
export = acme
`
const MODULAR = `export interface Auth { verify(token: string): string }
export declare function getAuth(): Auth
export declare function getApps(): string[]
export declare function cert(path: string): object
export declare function initializeApp(options?: object): void
`

const NOTES = `### Breaking Changes

* change: Remove Deprecated Legacy Namespace Support (#10)
* change: Drop support for Node.js 18 and 20 (#11)

### Bug Fixes

* fix: retry a token refresh that timed out (#12)
`

function version(v: string, publishedAt: string, types: string) {
  return {
    version: v,
    publishedAt,
    files: {
      "package.json": JSON.stringify({
        name: "acme-ns",
        version: v,
        main: "index.js",
        types: "index.d.ts",
      }),
      "index.js": "module.exports = {}",
      "index.d.ts": types,
    },
  }
}

const acme: FakePackage = {
  name: "acme-ns",
  repository: "git+https://github.com/acme/ns.git",
  versions: [
    version("1.0.0", "2026-08-01T00:00:00Z", NAMESPACE),
    version("2.0.0", "2026-09-01T00:00:00Z", MODULAR),
  ],
  releases: { "v2.0.0": NOTES },
}

describe("a breaking note naming no API, tied to the removals it describes", () => {
  it("lands the namespace note on the lines that use the namespace's removed names", async () => {
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "app",
          private: true,
          dependencies: { "acme-ns": "^1.0.0" },
        }),
        "node_modules/acme-ns/package.json": JSON.stringify({
          name: "acme-ns",
          version: "1.0.0",
          types: "index.d.ts",
        }),
        "node_modules/acme-ns/index.d.ts": NAMESPACE,
        "src/index.js": `const acme = require("acme-ns")\n\nif (!acme.apps.length) {\n  acme.initializeApp({ credential: acme.credential.cert("./key.json") })\n}\nmodule.exports = acme.auth().verify("t")\n`,
      },
    })
    let json: BriefV1
    let md: string
    try {
      const opts = testOptions(project.root, { latest: true })
      const brief = await run(opts, testCtx(opts, new FakeRegistry([acme])))
      const p = brief.packages.find((x) => x.pkg === "acme-ns")
      if (!p) throw new Error(JSON.stringify(brief.notAnalyzed))
      // the types already block: the tie changes what the reader is told, not the verdict
      expect(p.verdict).toBe("blocked")
      expect(
        p.surface.touched.map((t) => [t.bucket, t.change.path, t.strength])
      ).toEqual([
        ["removed", "acme-ns:apps", "strong"],
        ["removed", "acme-ns:auth", "strong"],
        ["removed", "acme-ns:credential", "strong"],
      ])
      expect(
        p.notes.matched.map((m) => [
          m.entry.title,
          m.direct,
          m.hits.map((h) => h.name),
        ])
      ).toEqual([
        [
          "change: Remove Deprecated Legacy Namespace Support (#10)",
          false,
          ["apps", "auth", "credential"],
        ],
      ])
      expect(p.notes.unattributedBreaking.map((e) => e.title)).toEqual([
        "change: Drop support for Node.js 18 and 20 (#11)",
      ])
      expect(p.usage.byName.credential?.map((s) => s.line)).toEqual([4])
      md = renderMarkdown(brief, opts.now)
      json = JSON.parse(renderJson(brief)) as BriefV1
    } finally {
      project.cleanup()
    }
    expect(md).toContain(
      "Remove Deprecated Legacy Namespace Support (#10) _(possibly)_. You use: `apps`, `auth`, `credential`"
    )
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../schema/brief-v1.schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    expect(validate(json, schema)).toEqual([])
  })
})
