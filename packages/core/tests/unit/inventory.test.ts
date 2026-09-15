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

  it("skips a lockfile written for another specifier, reads the next source, and says which it skipped", async () => {
    const npmLockWith = (declared: Record<string, string>, version: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: declared },
          "node_modules/a": { version },
        },
      })

    // a bot pull request that bumps a pin and leaves the lockfile behind
    const pinned = project({
      "package.json": pkgJson({ dependencies: { a: "2.4.0" } }),
      "package-lock.json": npmLockWith({ a: "2.3.0" }, "2.3.0"),
    })
    const inv = await buildInventory(pinned, { prod: false })
    expect(summary(inv)).toEqual([
      ["a", "2.4.0", "manifest-range", "range-guess"],
    ])
    expect(inv.installed[0]?.outOfSync).toEqual([
      { source: "lockfile:npm", version: "2.3.0", spec: "2.4.0" },
    ])
    cleanup?.()

    // node_modules behind a lockfile that matches the manifest: the lockfile wins
    const behind = project({
      "package.json": pkgJson({ dependencies: { a: "^1.1.0" } }),
      "node_modules/a/package.json": pkgJson({ name: "a", version: "1.1.0" }),
      "package-lock.json": npmLockWith({ a: "^1.1.0" }, "1.2.0"),
    })
    const behindInv = await buildInventory(behind, { prod: false })
    expect(summary(behindInv)).toEqual([["a", "1.2.0", "lockfile:npm", ""]])
    expect(behindInv.installed[0]?.outOfSync).toEqual([
      { source: "node_modules", version: "1.1.0", spec: "^1.1.0" },
    ])
    cleanup?.()

    // an edited manifest, neither installed nor locked yet: both are skipped
    const edited = project({
      "package.json": pkgJson({ dependencies: { a: "^2.0.0" } }),
      "node_modules/a/package.json": pkgJson({ name: "a", version: "1.0.0" }),
      "package-lock.json": npmLockWith({ a: "^1.0.0" }, "1.0.0"),
    })
    const editedInv = await buildInventory(edited, { prod: false })
    expect(summary(editedInv)).toEqual([
      ["a", "2.0.0", "manifest-range", "range-guess"],
    ])
    expect(editedInv.installed[0]?.outOfSync?.map((o) => o.source)).toEqual([
      "node_modules",
      "lockfile:npm",
    ])
  })

  it("trusts a lockfile that matches the manifest, even outside the range, or that records no specifier", async () => {
    // an override resolves outside the declared range, and the lockfile says so for this specifier
    const overridden = project({
      "package.json": pkgJson({ devDependencies: { a: "^3.1.1" } }),
      "pnpm-lock.yaml":
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      a:\n        specifier: ^3.1.1\n        version: 4.1.11(b@1.0.0)\n",
    })
    const overriddenInv = await buildInventory(overridden, { prod: false })
    expect(summary(overriddenInv)).toEqual([
      ["a", "4.1.11", "lockfile:pnpm", ""],
    ])
    expect(overriddenInv.installed[0]?.outOfSync).toBeUndefined()
    cleanup?.()

    const stalePnpm = project({
      "package.json": pkgJson({ dependencies: { a: "1.2.0" } }),
      "pnpm-lock.yaml":
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: 1.1.0\n        version: 1.1.0\n",
    })
    expect(
      (await buildInventory(stalePnpm, { prod: false })).installed[0]?.outOfSync
    ).toEqual([{ source: "lockfile:pnpm", version: "1.1.0", spec: "1.2.0" }])
    cleanup?.()

    // a peer range beside the real declaration: the lockfile records the real one
    const peer = project({
      "package.json": pkgJson({
        peerDependencies: { a: ">=0.1.0 <1.0.0" },
        devDependencies: { a: "0.21.0" },
      }),
      "pnpm-lock.yaml":
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      a:\n        specifier: 0.21.0\n        version: 0.21.0\n",
    })
    expect(
      (await buildInventory(peer, { prod: false })).installed.map((d) => [
        d.version,
        d.outOfSync,
      ])
    ).toEqual([["0.21.0", undefined]])
    cleanup?.()

    // an override is recorded under its own specifier, whatever the manifest says
    const overrideFiles: Record<string, string>[] = [
      { "pnpm-workspace.yaml": "overrides:\n  a: 'npm:b@2.0.0'\n" },
      {
        "package.json": pkgJson({
          dependencies: { a: "^1.0.0" },
          overrides: { a: "2.0.0" },
        }),
      },
    ]
    for (const overrides of overrideFiles) {
      const root = project({
        "package.json": pkgJson({ dependencies: { a: "^1.0.0" } }),
        "pnpm-lock.yaml":
          "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: 2.0.0\n        version: 2.0.0\n",
        ...overrides,
      })
      expect(
        (await buildInventory(root, { prod: false })).installed.map((d) => [
          d.version,
          d.versionSource,
          d.outOfSync,
        ])
      ).toEqual([["2.0.0", "lockfile:pnpm", undefined]])
      cleanup?.()
    }

    // another specifier whose version the manifest still allows, as with a catalog: not stale
    const catalog = project({
      "package.json": pkgJson({ dependencies: { a: "^1.0.0" } }),
      "pnpm-lock.yaml":
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: 'catalog:'\n        version: 1.4.0\n",
    })
    expect(
      (await buildInventory(catalog, { prod: false })).installed[0]?.outOfSync
    ).toBeUndefined()
    cleanup?.()

    const unrecorded = project({
      "package.json": pkgJson({ dependencies: { a: "2.4.0" } }),
      "node_modules/a/package.json": pkgJson({ name: "a", version: "2.3.0" }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/a": { version: "2.2.0" } },
      }),
    })
    const unrecordedInv = await buildInventory(unrecorded, { prod: false })
    expect(summary(unrecordedInv)).toEqual([["a", "2.3.0", "node_modules", ""]])
    expect(unrecordedInv.installed[0]?.outOfSync).toBeUndefined()
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
