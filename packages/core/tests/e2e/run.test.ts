import { join } from "node:path"
import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

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

const OLD = "2026-08-01T00:00:00Z"
const NEWISH = "2026-09-01T00:00:00Z"
const TOO_NEW = "2026-09-13T08:00:00Z"

const schemaTypes = (extra = "", parse = "parse(input: unknown): unknown") => `
export interface Schema {
  ${parse}
  strict(): this
}
export declare function object(shape: object): Schema
export declare function email(): Schema
${extra}
`

function version(
  name: string,
  v: string,
  publishedAt: string,
  types: string | undefined,
  extraPkg: Record<string, unknown> = {}
) {
  return {
    version: v,
    publishedAt,
    files: {
      "package.json": JSON.stringify({
        name,
        version: v,
        main: "index.js",
        ...(types !== undefined ? { types: "index.d.ts" } : {}),
        ...extraPkg,
      }),
      "index.js": "module.exports = {}",
      ...(types !== undefined ? { "index.d.ts": types } : {}),
    },
  }
}

const packages: FakePackage[] = [
  {
    // removes an export the project calls
    name: "acme-blocked",
    repository: "git+https://github.com/acme/blocked.git",
    versions: [
      version(
        "acme-blocked",
        "1.0.0",
        OLD,
        schemaTypes("export declare function legacy(): Schema")
      ),
      version("acme-blocked", "1.1.0", NEWISH, schemaTypes()),
    ],
    releases: {
      "v1.1.0":
        "## Changes\n\n- Remove the long deprecated `legacy()` helper, use `object()` instead.\n",
    },
  },
  {
    // one new export nobody uses, and notes that say nothing about the project
    name: "acme-quiet",
    repository: "git+https://github.com/acme/quiet.git",
    versions: [
      version("acme-quiet", "1.0.0", OLD, schemaTypes()),
      version(
        "acme-quiet",
        "1.0.1",
        NEWISH,
        schemaTypes("export declare function iban(): Schema")
      ),
      version(
        "acme-quiet",
        "1.0.2",
        TOO_NEW,
        schemaTypes("export declare function iban(): Schema")
      ),
    ],
    releases: {
      "v1.0.1":
        "- Add `iban()` for bank account numbers (#12)\n- ci: faster release job\n",
    },
  },
  {
    // same types, a note about a name the project reaches through a local proxy
    name: "acme-notes",
    repository: "git+https://github.com/acme/notes.git",
    versions: [
      version("acme-notes", "2.0.0", OLD, schemaTypes()),
      version("acme-notes", "2.1.0", NEWISH, schemaTypes()),
    ],
    releases: {
      "v2.1.0":
        "### ⚠️ The `email()` pattern rejects plus addresses\n\nAddresses like a+b@example.com now fail.\n",
    },
  },
  {
    // a member signature changes; the project reaches it through a schema built in another file
    name: "acme-member",
    repository: "git+https://github.com/acme/member.git",
    versions: [
      version("acme-member", "3.0.0", OLD, schemaTypes()),
      version(
        "acme-member",
        "3.1.0",
        NEWISH,
        schemaTypes("", "parse(input: unknown, strict: boolean): unknown")
      ),
    ],
    releases: { "v3.1.0": "- Internal cleanup\n" },
  },
  {
    // no types, no notes anywhere: invisible, so never quiet
    name: "acme-dark",
    versions: [
      version("acme-dark", "1.0.0", OLD, undefined),
      version("acme-dark", "1.2.0", NEWISH, undefined),
    ],
  },
  {
    // run from a script only
    name: "acme-cli",
    repository: "git+https://github.com/acme/cli.git",
    versions: [
      version("acme-cli", "1.0.0", OLD, undefined, { bin: { acme: "cli.js" } }),
      version("acme-cli", "1.0.1", NEWISH, undefined, {
        bin: { acme: "cli.js" },
      }),
    ],
    releases: { "v1.0.1": "- Fix a crash\n" },
  },
]

function installed(
  name: string,
  v: string,
  types?: string,
  extra: Record<string, unknown> = {}
) {
  const store = `node_modules/.pnpm/${name}@${v}/node_modules/${name}`
  return {
    files: {
      [`${store}/package.json`]: JSON.stringify({
        name,
        version: v,
        ...(types ? { types: "index.d.ts" } : {}),
        ...extra,
      }),
      ...(types ? { [`${store}/index.d.ts`]: types } : {}),
    },
    link: { [`packages/app/node_modules/${name}`]: store },
  }
}

describe("run, end to end against a fake registry", () => {
  let root: string
  let cleanup: () => void
  let brief: Brief
  let registry: FakeRegistry
  const byName = (n: string): PackageBrief => {
    const p = brief.packages.find((x) => x.pkg === n)
    if (!p)
      throw new Error(`no brief for ${n}: ${JSON.stringify(brief.notAnalyzed)}`)
    return p
  }

  beforeAll(async () => {
    const inst = [
      installed(
        "acme-blocked",
        "1.0.0",
        schemaTypes("export declare function legacy(): Schema")
      ),
      installed("acme-quiet", "1.0.0", schemaTypes()),
      installed("acme-notes", "2.0.0", schemaTypes()),
      installed("acme-member", "3.0.0", schemaTypes()),
      installed("acme-dark", "1.0.0"),
      installed("acme-cli", "1.0.0", undefined, { bin: { acme: "cli.js" } }),
    ]
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "root",
          private: true,
          workspaces: ["packages/*"],
        }),
        "packages/app/package.json": pkgJson({
          name: "app",
          private: true,
          scripts: { gen: "acme generate" },
          dependencies: {
            "acme-blocked": "^1.0.0",
            "acme-quiet": "^1.0.0",
            "acme-notes": "^2.0.0",
            "acme-member": "^3.0.0",
            "acme-dark": "^1.0.0",
            "acme-cli": "^1.0.0",
          },
        }),
        "packages/app/src/proxy.ts": `export * from "acme-notes"\nexport const LOCAL = 1\n`,
        "packages/app/src/uses-proxy.ts": `import * as s from "./proxy"\n\nexport const contact = s.object({ mail: s.email() })\n`,
        "packages/app/src/blocked.ts": `import { legacy, object } from "acme-blocked"\n\nlegacy()\nobject({})\n`,
        "packages/app/src/quiet.ts": `import * as q from "acme-quiet"\n\n// q.iban() is not called, a comment is not usage\nq.object({}).strict()\n`,
        "packages/app/src/schema.ts": `import { object } from "acme-member"\n\nexport const user = object({})\n`,
        "packages/app/src/member.ts": `import { user } from "./schema"\n\nexport function check(x: unknown) {\n  return user.parse(x)\n}\n`,
        "packages/app/src/dark.js": `const dark = require("acme-dark")\n\ndark.shade()\n`,
        ...Object.assign({}, ...inst.map((i) => i.files)),
      },
      symlinks: Object.assign({}, ...inst.map((i) => i.link)),
    })
    root = project.root
    cleanup = project.cleanup
    registry = new FakeRegistry(packages)
    const opts = testOptions(root)
    brief = await run(opts, testCtx(opts, registry))
  })

  afterAll(() => cleanup())

  it("blocks when an export the project calls is removed", () => {
    const p = byName("acme-blocked")
    expect(p.verdict).toBe("blocked")
    const removed = p.surface.touched.find((t) => t.bucket === "removed")
    expect(removed?.change.path).toBe("acme-blocked:legacy")
    expect(removed?.sites.map((s) => `${s.file}:${s.line}`)).toEqual([
      "packages/app/src/blocked.ts:3",
    ])
    expect(brief.exitCode).toBe(2)
  })

  it("is quiet when nothing used changed and the notes never mention it", () => {
    const p = byName("acme-quiet")
    expect(p.verdict).toBe("quiet")
    expect(p.to).toBe("1.0.1")
    expect(p.skippedNewer.map((s) => [s.version, s.reason])).toEqual([
      ["1.0.2", "too-new"],
    ])
    expect(p.surface.status).toBe("computed")
    expect(p.surface.touched).toEqual([])
    expect(p.notes.coverage).toBe("complete")
    expect(p.notes.matched).toEqual([])
  })

  it("follows a local proxy to match a note by name", () => {
    const p = byName("acme-notes")
    expect(p.verdict).toBe("review")
    expect(p.notes.matched).toHaveLength(1)
    expect(p.notes.matched[0]!.direct).toBe(true)
    expect(p.usage.byName.email?.map((s) => [s.file, s.line, s.via])).toEqual([
      ["packages/app/src/uses-proxy.ts", 3, ["packages/app/src/proxy.ts"]],
    ])
  })

  it("resolves a member through a value built in another file", () => {
    const p = byName("acme-member")
    expect(p.verdict).toBe("review")
    const changed = p.surface.touched.find(
      (t) => t.change.path === "acme-member:Schema#parse"
    )
    expect(changed?.strength).toBe("strong")
    expect(changed?.sites.map((s) => `${s.file}:${s.line}`)).toEqual([
      "packages/app/src/member.ts:4",
    ])
  })

  it("never calls a package quiet when neither net can see it", () => {
    const p = byName("acme-dark")
    expect(p.verdict).toBe("review")
    expect(p.surface.status).toBe("no-types")
    expect(p.notes.coverage).not.toBe("complete")
    expect(p.reasons.map((r) => r.code)).toContain("no-evidence")
  })

  it("never calls a script-only tool quiet", () => {
    const p = byName("acme-cli")
    expect(p.verdict).toBe("review")
    expect(p.usage.opaque.map((o) => o.kind)).toEqual(["script-bin"])
  })

  it("never leaves the fixtures", () => {
    const hosts = new Set(registry.requests.map((u) => new URL(u).host))
    for (const h of hosts)
      expect([
        "registry.npmjs.org",
        "api.github.com",
        "raw.githubusercontent.com",
      ]).toContain(h)
  })

  it("renders markdown and JSON from the same brief", () => {
    const md = renderMarkdown(brief, Date.parse("2026-09-13T09:00:00Z"))
    expect(md).toContain(
      "| `acme-blocked` | 1.0.0 → 1.1.0 (minor) | 🛑 blocked |"
    )
    expect((JSON.parse(renderJson(brief)) as BriefV1).schemaVersion).toBe(1)
  })

  it("keeps --json inside schema version 1", () => {
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../schema/brief-v1.schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    const output = JSON.parse(renderJson(brief)) as BriefV1
    expect(validate(output, schema)).toEqual([])
    expect(output.packages.length).toBeGreaterThan(0)
    // a field nobody put in the schema is a contract change, and fails here
    const drifted = {
      ...output,
      packages: [{ ...output.packages[0], extra: 1 }],
    }
    expect(validate(drifted, schema)).toEqual([
      "$.packages[0].extra: not in the schema",
    ])
  })

  it("gives the same brief twice, the second time from the cache alone", async () => {
    const opts = testOptions(root, { offline: true })
    const first = testOptions(root)
    const warm = new FakeRegistry(packages)
    const a = await run(
      { ...first, cacheDir: opts.cacheDir },
      testCtx({ ...first, cacheDir: opts.cacheDir }, warm)
    )
    const before = warm.requests.length
    const b = await run(opts, testCtx(opts, warm))
    expect(warm.requests.length).toBe(before)
    expect(JSON.stringify(b.packages)).toBe(JSON.stringify(a.packages))
  })
})
