import { afterEach, describe, expect, it } from "vitest"

import { scanUsage } from "../../src/usage/scan.ts"
import { buildInventory } from "../../src/inventory/installed.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import { listProjectFiles } from "../../src/inventory/manifests.ts"

let cleanup: (() => void) | undefined
afterEach(() => cleanup?.())

async function usageOf(
  files: Record<string, string>,
  pkg: string,
  symlinks?: Record<string, string>
) {
  const p = createProject({ files, ...(symlinks ? { symlinks } : {}) })
  cleanup = p.cleanup
  const all = await listProjectFiles(p.root)
  const inv = await buildInventory(p.root, { prod: false }, all)
  const u = await scanUsage(undefined, p.root, all, inv)
  const found = Object.values(u.packages).find((x) => x.pkg === pkg)
  return { usage: found, global: u.global }
}

const dep = (
  name: string,
  version = "1.0.0",
  extra: Record<string, unknown> = {}
) => ({
  [`node_modules/${name}/package.json`]: pkgJson({ name, version, ...extra }),
})

describe("usage link", () => {
  it("follows CommonJS values into callbacks", async () => {
    const { usage } = await usageOf(
      {
        "package.json": pkgJson({ dependencies: { express: "^4.0.0" } }),
        ...dep("express", "4.19.2"),
        "index.js": `const express = require("express")\nconst app = express()\napp.get("/", (req, res) => { res.redirect("back") })\n`,
      },
      "express"
    )
    expect(usage?.weakNames).toEqual(
      expect.arrayContaining(["get", "redirect"])
    )
    const redirect = usage?.refs.find((r) =>
      r.chain.some((c) => c.name === "redirect")
    )
    expect(redirect?.site.line).toBe(3)
  })

  it("resolves tsconfig paths and workspace packages to their files", async () => {
    const { usage } = await usageOf(
      {
        "package.json": pkgJson({ private: true }),
        "packages/lib/package.json": pkgJson({
          name: "@w/lib",
          exports: { ".": "./src/index.ts" },
        }),
        "packages/lib/src/index.ts": `export * from "schemakit"\nexport const own = 1\n`,
        "apps/web/package.json": pkgJson({
          name: "web",
          dependencies: { "@w/lib": "workspace:*", schemakit: "^4.0.0" },
        }),
        "apps/web/tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }`,
        "apps/web/src/schema.ts": `import { email, own } from "@w/lib"\nexport const e = email()\nexport { own }\n`,
        "apps/web/src/page.ts": `import { e } from "@/schema"\ne.parse("x")\n`,
        ...dep("schemakit", "4.5.4"),
      },
      "schemakit",
      { "apps/web/node_modules/@w/lib": "packages/lib" }
    )
    expect(usage?.strongNames).toEqual(["email"])
    expect(
      usage?.refs
        .map((r) => [r.site.file, r.site.line, r.site.via?.at(-1)])
        .sort()
    ).toEqual([
      ["apps/web/src/page.ts", 2, "apps/web/src/schema.ts"],
      ["apps/web/src/schema.ts", 2, "packages/lib/src/index.ts"],
    ])
  })

  it("lands a passed option on its call and on the line that writes it", async () => {
    const { usage } = await usageOf(
      {
        "package.json": pkgJson({ dependencies: { pooler: "^1.0.0" } }),
        ...dep("pooler"),
        "db.js": `const { Pool } = require("pooler")\nconst pool = new Pool({\n  max: 10,\n  ssl: true,\n})\n`,
      },
      "pooler"
    )
    expect(usage?.passedOptions?.ssl?.map((s) => s.line)).toEqual([2, 4])
    const ref = usage?.refs.find((r) => r.passed)
    expect(ref?.passed?.max?.line).toBe(3)
  })

  it("follows values of a package's types into their reads and passed keys", async () => {
    const { usage } = await usageOf(
      {
        "package.json": pkgJson({ dependencies: { kit: "^1.0.0" } }),
        ...dep("kit"),
        "src/types.ts": `export type { Context } from "kit"\n`,
        "src/load.ts": `import type { Context } from "./types"\nexport function load(ctx: Context) {\n  return ctx.store.list({\n    size: 5,\n  })\n}\n`,
      },
      "kit"
    )
    const read = usage?.refs.find((r) => r.binding.kind === "derived")
    expect(read?.chain.map((c) => c.name)).toEqual(["store", "list"])
    expect(read?.origin).toMatchObject({
      binding: { kind: "named", imported: "Context" },
      chain: [],
      instanceAt: 0,
    })
    expect(read?.site.line).toBe(3)
    expect(usage?.passedOptions?.size?.map((s) => s.line)).toEqual([3, 4])
    expect(usage?.strongNames).toEqual(["Context", "list", "store"])
    expect(usage?.weakNames).toEqual([])
  })

  it("reads a value declared with a package's type as surely as the import, up to its first call", async () => {
    const { usage } = await usageOf(
      {
        "package.json": pkgJson({ dependencies: { kit: "^1.0.0" } }),
        ...dep("kit"),
        "src/cli.ts": `import { Command } from "kit"\n\nexport class Cli {\n  constructor(private readonly program: Command) {}\n\n  init() {\n    this.program.command("run").action(() => undefined)\n  }\n\n  pass = (cmd: Command) => cmd.args\n}\n`,
      },
      "kit"
    )
    expect(usage?.strongNames).toEqual(["Command", "args", "command"])
    expect(usage?.weakNames).toEqual(["action"])
  })

  it("counts what it cannot see instead of skipping it", async () => {
    const { usage, global } = await usageOf(
      {
        "package.json": pkgJson({
          dependencies: { lib: "^1.0.0", polyfill: "^1.0.0" },
        }),
        ...dep("lib"),
        ...dep("polyfill"),
        "a.ts": `import * as lib from "lib"\nimport "polyfill"\nregister(lib)\nconst k = "x"\nlib[k]\nrequire(name)\n`,
      },
      "lib"
    )
    expect(usage?.blindSpots.map((b) => [b.kind, b.count])).toEqual([
      ["computed-member", 1],
      ["namespace-escape", 1],
    ])
    expect(global.map((g) => g.kind)).toEqual(["require-nonliteral"])
  })

  it("does not count a lint rule naming a package it imports as config usage", async () => {
    const { usage } = await usageOf(
      {
        "package.json": pkgJson({
          dependencies: { schemakit: "^4.0.0", "prettier-plugin-x": "^1.0.0" },
        }),
        ...dep("schemakit"),
        ...dep("prettier-plugin-x"),
        "a.ts": `import * as v from "schemakit"\nv.string()\n`,
        "eslint.config.js": `export default [{ rules: { "no-restricted-imports": ["error", { paths: [{ name: "schemakit" }] }] } }]\n`,
        ".prettierrc.json": `{ "plugins": ["prettier-plugin-x"] }`,
      },
      "schemakit"
    )
    expect(usage?.opaque).toEqual([])
    const plugin = await usageOf(
      {
        "package.json": pkgJson({
          dependencies: { "prettier-plugin-x": "^1.0.0" },
        }),
        ...dep("prettier-plugin-x"),
        ".prettierrc.json": `{ "plugins": ["prettier-plugin-x"] }`,
      },
      "prettier-plugin-x"
    )
    expect(plugin.usage?.opaque.map((o) => o.kind)).toEqual([
      "config-reference",
    ])
  })
})
