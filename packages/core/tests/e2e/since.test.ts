import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { run } from "../../src/run.ts"
import type { Brief } from "../../src/model.ts"
import { validate } from "../helpers/json-schema.ts"
import { renderJson } from "../../src/render/json.ts"
import { planSince } from "../../src/inventory/since.ts"
import { renderMarkdown } from "../../src/render/markdown.ts"
import { createProject, pkgJson } from "../helpers/tmp-project.ts"
import {
  type FakePackage,
  FakeRegistry,
  testCtx,
  testOptions,
} from "../helpers/fake-registry.ts"

const OLD = "2026-08-01T00:00:00Z"
// an hour before the test clock: too new for the default cooldown, yet chosen by the change
const FRESH = "2026-09-13T08:00:00Z"

const types = (extra: string) =>
  `export declare function object(shape: object): unknown\n${extra}\n`

function version(name: string, v: string, publishedAt: string, dts: string) {
  return {
    version: v,
    publishedAt,
    files: {
      "package.json": JSON.stringify({ name, version: v, types: "index.d.ts" }),
      "index.d.ts": dts,
    },
  }
}

const packages: FakePackage[] = [
  {
    name: "acme-lib",
    repository: "git+https://github.com/acme/lib.git",
    versions: [
      version(
        "acme-lib",
        "1.0.0",
        OLD,
        types("export declare function legacy(): void")
      ),
      version("acme-lib", "1.1.0", FRESH, types("")),
      version("acme-lib", "1.2.0", FRESH, types("")),
    ],
    releases: { "v1.1.0": "- Remove `legacy()`\n" },
  },
  {
    name: "acme-steady",
    repository: "git+https://github.com/acme/steady.git",
    versions: [
      version("acme-steady", "1.0.0", OLD, types("")),
      version("acme-steady", "1.5.0", OLD, types("")),
    ],
  },
  {
    name: "acme-new",
    versions: [version("acme-new", "2.0.0", OLD, types(""))],
  },
]

function lockfile(deps: Record<string, string>): string {
  const entries = Object.fromEntries(
    Object.entries(deps).map(([name, v]) => [
      `node_modules/${name}`,
      { version: v },
    ])
  )
  return `${JSON.stringify(
    { lockfileVersion: 3, packages: { "": { name: "app" }, ...entries } },
    null,
    2
  )}\n`
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=radius", "-c", "user.email=radius@example.com", ...args],
    { cwd: root, encoding: "utf8" }
  ).trim()
}

describe("run --since, against a real git history", () => {
  let root: string
  let cleanup: () => void
  let brief: Brief
  let baseCommit: string

  beforeAll(async () => {
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "app",
          private: true,
          dependencies: { "acme-lib": "^1.0.0", "acme-steady": "^1.0.0" },
        }),
        "package-lock.json": lockfile({
          "acme-lib": "1.0.0",
          "acme-steady": "1.0.0",
        }),
        "src/index.ts": `import { legacy, object } from "acme-lib"\nimport { object as o } from "acme-steady"\n\nlegacy()\nobject({})\no({})\n`,
      },
    })
    root = project.root
    cleanup = project.cleanup
    rmSync(join(root, ".git"), { recursive: true })
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    baseCommit = git(root, "rev-parse", "HEAD")

    // the upgrade, as a bot pull request makes it: lockfile and manifest only, never committed here
    writeFileSync(
      join(root, "package.json"),
      pkgJson({
        name: "app",
        private: true,
        dependencies: {
          "acme-lib": "^1.1.0",
          "acme-steady": "^1.0.0",
          "acme-new": "^2.0.0",
        },
      })
    )
    writeFileSync(
      join(root, "package-lock.json"),
      lockfile({
        "acme-lib": "1.1.0",
        "acme-steady": "1.0.0",
        "acme-new": "2.0.0",
      })
    )

    const opts = testOptions(root, { since: "main" })
    brief = await run(opts, testCtx(opts, new FakeRegistry(packages)))
  })

  afterAll(() => cleanup())

  it("analyses exactly the version the change picked, however fresh", () => {
    expect(brief.packages.map((p) => `${p.pkg} ${p.from} ${p.to}`)).toEqual([
      "acme-lib 1.0.0 1.1.0",
    ])
    expect(brief.packages[0]!.verdict).toBe("blocked")
  })

  it("leaves unchanged dependencies out, even with a newer version on the registry", () => {
    expect(brief.upToDate).toBe(1)
    expect(brief.packages.some((p) => p.pkg === "acme-steady")).toBe(false)
  })

  it("reports a dependency added by the change as not analysed", () => {
    expect(brief.notAnalyzed).toContainEqual({
      pkg: "acme-new",
      reason: "added since main, so there is no earlier version to compare",
    })
  })

  it("names the ref and its commit in every output", () => {
    expect(brief.since).toEqual({ ref: "main", commit: baseCommit })
    expect(renderMarkdown(brief, Date.parse("2026-09-13T09:00:00Z"))).toContain(
      `Dependency changes since main (${baseCommit.slice(0, 7)}).`
    )
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../schema/brief-v1.schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    const json: unknown = JSON.parse(renderJson(brief))
    expect(validate(json, schema)).toEqual([])
  })

  it("refuses a ref that does not exist, and --latest or @version with --since", async () => {
    const bad = testOptions(root, { since: "no-such-branch" })
    await expect(
      run(bad, testCtx(bad, new FakeRegistry(packages)))
    ).rejects.toThrow("--since no-such-branch: no such commit here")
    const exact = testOptions(root, {
      since: "main",
      specs: ["acme-lib@1.2.0"],
    })
    await expect(
      run(exact, testCtx(exact, new FakeRegistry(packages)))
    ).rejects.toThrow("package names only")
  })

  it("reads the ref from a package folder inside the repository", async () => {
    const opts = testOptions(join(root, "src"), { since: "main" })
    const inner = await run(opts, testCtx(opts, new FakeRegistry(packages)))
    expect(inner.since?.commit).toBe(baseCommit)
  })
})

describe("run --since, from a package of a monorepo", () => {
  let root: string
  let cleanup: () => void

  beforeAll(() => {
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "mono",
          private: true,
          workspaces: ["packages/*"],
        }),
        "package-lock.json": lockfile({ "acme-lib": "1.0.0" }),
        "packages/api/package.json": pkgJson({
          name: "api",
          dependencies: { "acme-lib": "^1.0.0" },
        }),
        "packages/api/src/index.ts": `import { legacy } from "acme-lib"\n\nlegacy()\n`,
      },
    })
    root = project.root
    cleanup = project.cleanup
    rmSync(join(root, ".git"), { recursive: true })
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    writeFileSync(
      join(root, "package-lock.json"),
      lockfile({ "acme-lib": "1.1.0" })
    )
  })

  afterAll(() => cleanup())

  it("reads the lockfile at the repository root, now and at the ref", async () => {
    const opts = testOptions(join(root, "packages/api"), { since: "main" })
    const brief = await run(opts, testCtx(opts, new FakeRegistry(packages)))
    expect(
      brief.packages.map((p) => [p.pkg, p.from, p.to, p.versionSource])
    ).toEqual([["acme-lib", "1.0.0", "1.1.0", "lockfile:npm"]])
    expect(brief.packages[0]!.verdict).toBe("blocked")
  })

  it("reads the root lockfile without --since too, instead of guessing from the range", async () => {
    const opts = testOptions(join(root, "packages/api"), {
      specs: ["acme-lib@1.2.0"],
    })
    const brief = await run(opts, testCtx(opts, new FakeRegistry(packages)))
    expect(brief.packages[0]?.from).toBe("1.1.0")
    expect(brief.packages[0]?.versionSource).toBe("lockfile:npm")
  })
})

describe("run --since, when the change bumps a pin and leaves the lockfile behind", () => {
  let root: string
  let cleanup: () => void
  let brief: Brief

  beforeAll(async () => {
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "app",
          private: true,
          dependencies: { "acme-lib": "1.0.0" },
        }),
        // written by npm: the root entry repeats what the manifest declared
        "package-lock.json": `${JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              "": { name: "app", dependencies: { "acme-lib": "1.0.0" } },
              "node_modules/acme-lib": { version: "1.0.0" },
            },
          },
          null,
          2
        )}\n`,
        "src/index.ts": `import { legacy } from "acme-lib"\n\nlegacy()\n`,
      },
    })
    root = project.root
    cleanup = project.cleanup
    rmSync(join(root, ".git"), { recursive: true })
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    writeFileSync(
      join(root, "package.json"),
      pkgJson({
        name: "app",
        private: true,
        dependencies: { "acme-lib": "1.1.0" },
      })
    )

    const opts = testOptions(root, { since: "main" })
    brief = await run(opts, testCtx(opts, new FakeRegistry(packages)))
  })

  afterAll(() => cleanup())

  it("compares the version the manifest pins, not the stale lockfile entry", () => {
    expect(brief.packages.map((p) => [p.pkg, p.from, p.to])).toEqual([
      ["acme-lib", "1.0.0", "1.1.0"],
    ])
    expect(brief.packages[0]!.verdict).toBe("blocked")
  })

  it("says the lockfile disagrees with the manifest", () => {
    expect(brief.packages[0]!.reasons).toContainEqual({
      code: "out-of-sync",
      detail:
        "package.json asks for 1.1.0 but the lockfile has 1.0.0, so that version was not used",
    })
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../schema/brief-v1.schema.json"),
        "utf8"
      )
    ) as Record<string, unknown>
    expect(validate(JSON.parse(renderJson(brief)), schema)).toEqual([])
  })
})

describe("run --since, with a folder installed separately", () => {
  let root: string
  let cleanup: () => void
  let brief: Brief

  const npmLock = (deps: Record<string, [string, string]>) =>
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: Object.fromEntries(
              Object.entries(deps).map(([n, [spec]]) => [n, spec])
            ),
          },
          ...Object.fromEntries(
            Object.entries(deps).map(([n, [, v]]) => [
              `node_modules/${n}`,
              { version: v },
            ])
          ),
        },
      },
      null,
      2
    )}\n`

  beforeAll(async () => {
    const project = createProject({
      files: {
        "package.json": pkgJson({
          name: "app",
          private: true,
          dependencies: { "acme-lib": "^1.0.0" },
        }),
        "package-lock.json": npmLock({ "acme-lib": ["^1.0.0", "1.0.0"] }),
        "src/index.ts": `import { object } from "acme-lib"\n\nobject({})\n`,
        // deployed on its own, pinned to the old version by its own lockfile
        "functions/package.json": pkgJson({
          name: "functions",
          private: true,
          dependencies: { "acme-lib": "1.0.0" },
        }),
        "functions/package-lock.json": npmLock({
          "acme-lib": ["1.0.0", "1.0.0"],
        }),
        "functions/index.ts": `import { legacy } from "acme-lib"\n\nlegacy()\n`,
      },
    })
    root = project.root
    cleanup = project.cleanup
    rmSync(join(root, ".git"), { recursive: true })
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    // the bot bumps the root only
    writeFileSync(
      join(root, "package.json"),
      pkgJson({
        name: "app",
        private: true,
        dependencies: { "acme-lib": "^1.1.0" },
      })
    )
    writeFileSync(
      join(root, "package-lock.json"),
      npmLock({ "acme-lib": ["^1.1.0", "1.1.0"] })
    )

    const opts = testOptions(root, { since: "main" })
    brief = await run(opts, testCtx(opts, new FakeRegistry(packages)))
  })

  afterAll(() => cleanup())

  it("reports the root's upgrade on the root's code only", () => {
    expect(
      brief.packages.map((p) => [p.pkg, p.from, p.to, p.manifests])
    ).toEqual([["acme-lib", "1.0.0", "1.1.0", ["package.json"]]])
    const files = brief.packages[0]!.usage.sites.map((s) => s.file)
    expect(files).toContain("src/index.ts")
    expect(files).not.toContain("functions/index.ts")
    // functions still calls legacy(), removed in 1.1.0, but it does not get 1.1.0
    expect(brief.packages[0]!.verdict).not.toBe("blocked")
  })
})

describe("run --since, with two separate installs of the same package", () => {
  let root: string
  let cleanup: () => void

  const pnpmLock = (spec: string, version: string) =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      acme-lib:\n        specifier: ${spec}\n        version: ${version}\n`

  beforeAll(() => {
    const project = createProject({
      files: {
        "backend/package.json": pkgJson({
          name: "backend",
          private: true,
          dependencies: { "acme-lib": "^1.0.0" },
        }),
        "backend/pnpm-lock.yaml": pnpmLock("^1.0.0", "1.0.0"),
        "backend/index.ts": `import { legacy } from "acme-lib"\n\nlegacy()\n`,
        // already on the new version before the change
        "tools/package.json": pkgJson({
          name: "tools",
          private: true,
          dependencies: { "acme-lib": "^1.1.0" },
        }),
        "tools/pnpm-lock.yaml": pnpmLock("^1.1.0", "1.1.0"),
        "tools/index.ts": `import { object } from "acme-lib"\n\nobject({})\n`,
      },
    })
    root = project.root
    cleanup = project.cleanup
    rmSync(join(root, ".git"), { recursive: true })
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    writeFileSync(
      join(root, "backend/package.json"),
      pkgJson({
        name: "backend",
        private: true,
        dependencies: { "acme-lib": "^1.1.0" },
      })
    )
    writeFileSync(
      join(root, "backend/pnpm-lock.yaml"),
      pnpmLock("^1.1.0", "1.1.0")
    )
  })

  afterAll(() => cleanup())

  it("sees the install that moved, even when another one already had that version", async () => {
    const opts = testOptions(root, { since: "main" })
    const brief = await run(opts, testCtx(opts, new FakeRegistry(packages)))
    expect(
      brief.packages.map((p) => [p.pkg, p.from, p.to, p.manifests])
    ).toEqual([["acme-lib", "1.0.0", "1.1.0", ["backend/package.json"]]])
    expect(brief.packages[0]!.verdict).toBe("blocked")
  })
})

describe("planSince", () => {
  const dep = (name: string, version: string, manifest = "package.json") => ({
    id: `lockfile:npm:${name}@${version}`,
    name,
    version,
    versionSource: "lockfile:npm" as const,
    local: false,
    declaredBy: [{ manifest, key: name, field: "dependencies" as const }],
    flags: [],
  })
  const manifest = (keys: string[]) => ({
    path: "/p/package.json",
    dir: "/p",
    name: "app",
    private: true,
    deps: keys.map((key) => ({
      key,
      spec: "^1.0.0",
      field: "dependencies" as const,
      specKind: "range" as const,
    })),
    scripts: {},
    exports: undefined,
    main: undefined,
    module: undefined,
    types: undefined,
  })

  it("pairs a dependency with the same declaration at the ref, not with another manifest's version", () => {
    const plan = planSince(
      [dep("a", "3.0.0", "apps/web/package.json")],
      {
        root: "/p",
        installed: [
          dep("a", "2.0.0", "apps/web/package.json"),
          dep("a", "1.0.0", "apps/api/package.json"),
        ],
        manifests: [],
      },
      "main"
    )
    expect(plan.changed.map((c) => [c.dep.version, c.to])).toEqual([
      ["2.0.0", "3.0.0"],
    ])
  })

  it("counts a dependency declared in a new manifest as added, whatever other manifests hold", () => {
    const plan = planSince(
      [dep("a", "3.0.0", "apps/docs/package.json")],
      {
        root: "/p",
        installed: [dep("a", "2.0.0", "apps/api/package.json")],
        manifests: [],
      },
      "main"
    )
    expect(plan.changed).toEqual([])
    expect(plan.added[0]?.reason).toContain("added since main")
  })

  it("says the earlier version is unknown when the ref declared the package without a lockfile entry", () => {
    const plan = planSince(
      [dep("a", "1.0.0")],
      { root: "/p", installed: [], manifests: [manifest(["a"])] },
      "main"
    )
    expect(plan.added[0]?.reason).toContain("its version at main is unknown")
  })
})
