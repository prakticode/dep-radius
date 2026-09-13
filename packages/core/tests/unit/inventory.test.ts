import { afterEach, describe, expect, it } from "vitest"

import { buildInventory } from "../../src/inventory/installed.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import { classifySpec, packageNameOf } from "../../src/inventory/specifiers.ts"

let cleanup: (() => void) | undefined
afterEach(() => cleanup?.())

function project(
  files: Record<string, string>,
  symlinks?: Record<string, string>
) {
  const p = createProject({ files, ...(symlinks ? { symlinks } : {}) })
  cleanup = p.cleanup
  return p.root
}

const summary = (inv: Awaited<ReturnType<typeof buildInventory>>) =>
  inv.installed.map((d) => [
    d.name,
    d.version,
    d.versionSource,
    d.flags.join(","),
  ])

describe("buildInventory", () => {
  it("reads the version off node_modules, whatever installed it", async () => {
    const root = project({
      "package.json": pkgJson({
        dependencies: { a: "^1.0.0", "@s/b": "^2.0.0" },
        devDependencies: { c: "*" },
      }),
      "node_modules/a/package.json": pkgJson({ name: "a", version: "1.4.0" }),
      "node_modules/@s/b/package.json": pkgJson({
        name: "@s/b",
        version: "2.1.3",
      }),
      "node_modules/c/package.json": pkgJson({ name: "c", version: "9.0.0" }),
    })
    expect(summary(await buildInventory(root, { prod: false }))).toEqual([
      ["@s/b", "2.1.3", "node_modules", ""],
      ["a", "1.4.0", "node_modules", ""],
      ["c", "9.0.0", "node_modules", ""],
    ])
    expect(
      summary(await buildInventory(root, { prod: true })).map((x) => x[0])
    ).toEqual(["@s/b", "a"])
  })

  it("follows pnpm's symlinks, finds aliases, and never mistakes a workspace package for a registry one", async () => {
    const root = project(
      {
        "package.json": pkgJson({ private: true }),
        "packages/app/package.json": pkgJson({
          name: "app",
          dependencies: {
            schemakit: "^4.0.0",
            "ts-native": "npm:typescript@^7",
            "@w/lib": "workspace:*",
          },
        }),
        "packages/lib/package.json": pkgJson({ name: "@w/lib" }),
        "node_modules/.pnpm/schemakit@4.5.4/node_modules/schemakit/package.json":
          pkgJson({
            name: "schemakit",
            version: "4.5.4",
          }),
        "node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/package.json":
          pkgJson({ name: "typescript", version: "7.0.2" }),
        // generated output never counts as a manifest
        "packages/app/.next/server/package.json": pkgJson({ type: "commonjs" }),
      },
      {
        "packages/app/node_modules/schemakit":
          "node_modules/.pnpm/schemakit@4.5.4/node_modules/schemakit",
        "packages/app/node_modules/ts-native":
          "node_modules/.pnpm/typescript@7.0.2/node_modules/typescript",
        "packages/app/node_modules/@w/lib": "packages/lib",
      }
    )
    const inv = await buildInventory(root, { prod: false })
    expect(summary(inv)).toEqual([
      ["schemakit", "4.5.4", "node_modules", ""],
      ["typescript", "7.0.2", "node_modules", "alias"],
    ])
    expect(inv.local).toEqual(["@w/lib"])
    expect(inv.manifests).toHaveLength(3)
  })

  it("falls back to the lockfile, then to the range, and says which it used", async () => {
    const npm = project({
      "package.json": pkgJson({ dependencies: { a: "^1.0.0" } }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/a": { version: "1.2.3" } },
      }),
    })
    expect(summary(await buildInventory(npm, { prod: false }))).toEqual([
      ["a", "1.2.3", "lockfile:npm", ""],
    ])
    cleanup?.()

    const pnpm = project({
      "package.json": pkgJson({ dependencies: { a: "^1.0.0" } }),
      "pnpm-lock.yaml":
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: ^1.0.0\n        version: 1.5.0(peer@2.0.0)\n",
    })
    expect(summary(await buildInventory(pnpm, { prod: false }))).toEqual([
      ["a", "1.5.0", "lockfile:pnpm", ""],
    ])
    cleanup?.()

    const yarn = project({
      "package.json": pkgJson({ dependencies: { a: "^1.0.0" } }),
      "yarn.lock": '# yarn lockfile v1\n\n"a@^1.0.0":\n  version "1.6.0"\n',
    })
    expect(summary(await buildInventory(yarn, { prod: false }))).toEqual([
      ["a", "1.6.0", "lockfile:yarn", ""],
    ])
    cleanup?.()

    const bare = project({
      "package.json": pkgJson({
        dependencies: { a: "^1.3.0", b: "catalog:", c: "github:o/c" },
      }),
    })
    const inv = await buildInventory(bare, { prod: false })
    expect(summary(inv)).toEqual([
      ["a", "1.3.0", "manifest-range", "range-guess"],
    ])
    expect(inv.notAnalyzed.map((n) => n.pkg)).toEqual(["b", "c"])
  })

  it("flags patched packages", async () => {
    const root = project({
      "package.json": pkgJson({ dependencies: { a: "^1.0.0" } }),
      "node_modules/a/package.json": pkgJson({ name: "a", version: "1.0.0" }),
      "patches/a+1.0.0.patch": "",
    })
    expect(summary(await buildInventory(root, { prod: false }))).toEqual([
      ["a", "1.0.0", "node_modules", "patched"],
    ])
  })
})

describe("specifiers", () => {
  it("classifies every spec form", () => {
    expect(
      [
        "^1.0.0",
        "latest",
        "workspace:*",
        "catalog:",
        "npm:typescript@^7",
        "file:../x",
        "link:../y",
        "github:o/r",
        "https://x/y.tgz",
      ].map((s) => classifySpec(s).kind)
    ).toEqual([
      "range",
      "tag",
      "workspace",
      "catalog",
      "alias",
      "file",
      "link",
      "git",
      "url",
    ])
  })

  it("names the package of a specifier", () => {
    expect(
      ["schemakit/locales", "@a/b/c", "./x", "node:fs", "#internal"].map(
        packageNameOf
      )
    ).toEqual(["schemakit", "@a/b", undefined, undefined, undefined])
  })
})
