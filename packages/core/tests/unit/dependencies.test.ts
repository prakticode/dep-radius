import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"

import { describe, expect, it } from "vitest"

import type { HttpClient } from "../../src/infra/http.ts"
import type { RegistryConfig } from "../../src/registry/npmrc.ts"
import { build, extractSurface } from "../../src/surface/extract.ts"
import { getPackument, type Packument } from "../../src/registry/packument.ts"
import {
  type FakePackage,
  FakeRegistry,
  testCtx,
  testOptions,
} from "../helpers/fake-registry.ts"
import {
  importedDependencies,
  loadDependencyTypes,
  packageOfSpecifier,
  resolveRange,
} from "../../src/surface/dependencies.ts"

const cfg: RegistryConfig = {
  defaultRegistry: "https://registry.npmjs.org",
  scoped: {},
  tokens: {},
  minimumReleaseAgeExclude: [],
}

function tree(files: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]))
}

// a hook whose options type lives in the core package it depends on
const hook = {
  "package.json": JSON.stringify({
    name: "react-hook",
    types: "index.d.ts",
    dependencies: { core: "^1.0.0", unused: "^1.0.0" },
    peerDependencies: { react: "*" },
  }),
  "index.d.ts": [
    'import type { QueryOptions } from "core"',
    'import type { ReactNode } from "react"',
    "export declare function useQuery(options: QueryOptions): ReactNode",
  ].join("\n"),
}

const core = (
  version: string,
  extra = ""
): FakePackage["versions"][number] => ({
  version,
  publishedAt: "2026-01-01T00:00:00Z",
  files: {
    "package.json": JSON.stringify({
      name: "core",
      version,
      types: "index.d.ts",
    }),
    "index.d.ts": `export interface QueryOptions { queryKey: string[]; subscribed?: boolean${extra} }`,
  },
})

// a peer dependency that ships no declarations
const react: FakePackage = {
  name: "react",
  versions: [
    {
      version: "19.0.0",
      publishedAt: "2026-01-01T00:00:00Z",
      files: {
        "package.json": JSON.stringify({ name: "react" }),
        "index.js": "",
      },
    },
  ],
}

describe("dependency types", () => {
  it("names the package a specifier imports", () => {
    expect(packageOfSpecifier("core")).toBe("core")
    expect(packageOfSpecifier("core/sub/path")).toBe("core")
    expect(packageOfSpecifier("@scope/core/sub")).toBe("@scope/core")
    expect(packageOfSpecifier("./local")).toBeUndefined()
    expect(packageOfSpecifier("node:fs")).toBeUndefined()
    expect(packageOfSpecifier("@scope")).toBeUndefined()
  })

  it("keeps the dependencies the declarations import, and nothing else", () => {
    const files = tree({
      "package.json": JSON.stringify({
        name: "p",
        dependencies: {
          "@scope/core": "^2.0.0",
          "@types/serve-static": "*",
          unused: "^1.0.0",
          globals: "1.0.0",
        },
        peerDependencies: { react: "^18 || ^19" },
        devDependencies: { dev: "^1.0.0" },
      }),
      "index.d.ts": [
        '/// <reference types="globals" />',
        'import type { A } from "@scope/core/types"',
        'import type { B } from "./local"',
        'import type { C } from "serve-static"',
        'import type { D } from "dev"',
        'import type { E } from "not-declared"',
        'export * from "react"',
      ].join("\n"),
      "README.md": 'import "unused"',
    })
    expect(importedDependencies("p", files)).toEqual([
      { name: "@scope/core", range: "^2.0.0" },
      { name: "@types/serve-static", range: "*" },
      { name: "globals", range: "1.0.0" },
      { name: "react", range: "^18 || ^19" },
    ])
  })

  it("resolves a range to the highest version it allows, or a dist-tag", () => {
    const p = {
      name: "core",
      "dist-tags": { latest: "1.2.0", next: "2.0.0-rc.1" },
      time: {},
      versions: Object.fromEntries(
        ["1.0.0", "1.2.0", "2.0.0-rc.1"].map((v) => [
          v,
          { version: v, dist: { tarball: "" } },
        ])
      ),
    } satisfies Packument
    expect(resolveRange(p, "^1.0.0")).toBe("1.2.0")
    expect(resolveRange(p, "1.0.0")).toBe("1.0.0")
    expect(resolveRange(p, "next")).toBe("2.0.0-rc.1")
    expect(resolveRange(p, "^3.0.0")).toBeUndefined()
    expect(resolveRange(p, "workspace:*")).toBeUndefined()
  })

  it("reads the options a package takes from a dependency's types once they are mounted", () => {
    const alone = build("react-hook", "1.0.0", "sha512-x", tree(hook))
    if (!alone.ok) throw new Error(alone.reason)
    expect(
      alone.surface.symbols["react-hook:useQuery"]?.options
    ).toBeUndefined()
    expect(alone.surface.flags).toContain("external-types-unresolved")

    const withCore = build("react-hook", "1.0.0", "sha512-x", tree(hook), [], {
      packages: new Map([["core", tree(core("1.2.0").files)]]),
      versions: { core: "1.2.0" },
    })
    if (!withCore.ok) throw new Error(withCore.reason)
    expect(withCore.surface.symbols["react-hook:useQuery"]?.options).toEqual([
      "queryKey",
      "subscribed",
    ])
    expect(withCore.surface.dependencyTypes).toEqual({ core: "1.2.0" })
  })

  it("loads the imported dependencies at the version their range picks, skipping those without types", async () => {
    const registry = new FakeRegistry([
      { name: "core", versions: [core("1.0.0"), core("1.2.0"), core("2.0.0")] },
      react,
    ])
    const opts = testOptions(mkdtempSync(join(tmpdir(), "radius-deps-")))
    const deps = await loadDependencyTypes(
      testCtx(opts, registry),
      cfg,
      "react-hook",
      tree(hook)
    )
    expect(deps.versions).toEqual({ core: "1.2.0" })
    expect([...deps.packages.get("core")!.keys()].sort()).toEqual([
      "index.d.ts",
      "package.json",
    ])
    expect(deps.transient).toBe(false)
    // never asked for: `unused` is imported by no declaration
    expect(registry.requests.some((u) => u.includes("unused"))).toBe(false)
  })

  it("stays within the limits, and says when a dependency may load later", async () => {
    const registry = new FakeRegistry([
      { name: "core", versions: [core("1.2.0", "; ".repeat(2000))] },
      react,
    ])
    const dir = mkdtempSync(join(tmpdir(), "radius-deps-"))
    const tooBig = await loadDependencyTypes(
      testCtx(testOptions(dir, { cacheDir: dir }), registry),
      cfg,
      "react-hook",
      tree(hook),
      { packages: 8, bytesEach: 1000, bytesTotal: 10_000 }
    )
    expect(tooBig.packages.size).toBe(0)
    expect(tooBig.transient).toBe(false)

    const cold = await loadDependencyTypes(
      testCtx(
        testOptions(mkdtempSync(join(tmpdir(), "radius-deps-")), {
          offline: true,
        }),
        registry
      ),
      cfg,
      "react-hook",
      tree(hook)
    )
    expect(cold.packages.size).toBe(0)
    expect(cold.transient).toBe(true)

    // offline, what an earlier run cached is enough
    const warm = await loadDependencyTypes(
      testCtx(testOptions(dir, { cacheDir: dir, offline: true }), registry),
      cfg,
      "react-hook",
      tree(hook)
    )
    expect(warm.transient).toBe(false)
  })

  it("keeps no surface built while a dependency could not be fetched", async () => {
    const hookPackage: FakePackage = {
      name: "react-hook",
      versions: [
        { version: "1.0.0", publishedAt: "2026-01-01T00:00:00Z", files: hook },
      ],
    }
    const registry = new FakeRegistry([hookPackage, react])
    // the core package is unreachable, then back
    let down = true
    const flaky: HttpClient = {
      get: (req) =>
        down && req.url.endsWith("/core")
          ? Promise.resolve({ status: 503, headers: {}, body: Buffer.from("") })
          : registry.get(req),
    }
    const opts = testOptions(mkdtempSync(join(tmpdir(), "radius-deps-")))
    const ctx = testCtx(opts, flaky)
    const p = await getPackument(ctx, cfg, "react-hook")
    if (!p.ok) throw new Error(p.reason)
    const first = await extractSurface(ctx, cfg, p.packument, "1.0.0")
    expect(first.ok).toBe(true)
    expect(existsSync(join(opts.cacheDir, "surfaces"))).toBe(false)

    registry.add({ name: "core", versions: [core("1.2.0")] })
    down = false
    const up = await extractSurface(ctx, cfg, p.packument, "1.0.0")
    if (!up.ok) throw new Error(up.reason)
    expect(up.surface.symbols["react-hook:useQuery"]?.options).toEqual([
      "queryKey",
      "subscribed",
    ])
    expect(readdirSync(join(opts.cacheDir, "surfaces"))).toHaveLength(1)
  })
})
