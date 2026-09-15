import { describe, expect, it } from "vitest"

import { repositoryKey } from "../src/npm.ts"
import { releaseGroups } from "../src/groups.ts"
import { bumpOf, isTestFile, LOCKED_PERCENT, splitOf } from "../src/labels.ts"

const up = (name: string, from: string, to: string) => ({ name, from, to })

describe("bumpOf", () => {
  it("takes the largest step among the upgrades", () => {
    expect(bumpOf([up("a", "1.2.3", "1.2.4")])).toBe("patch")
    expect(bumpOf([up("a", "1.2.3", "1.2.4"), up("b", "1.0.0", "1.1.0")])).toBe(
      "minor"
    )
    expect(bumpOf([up("a", "1.2.3", "2.0.0"), up("b", "1.0.0", "1.1.0")])).toBe(
      "major"
    )
  })

  it("reads a 0.x minor as a major, as semver's caret does", () => {
    expect(bumpOf([up("a", "0.22.4", "0.23.0")])).toBe("major")
    expect(bumpOf([up("a", "0.3.0", "0.3.1")])).toBe("patch")
  })
})

describe("isTestFile", () => {
  it("recognises test folders, test suffixes and test runner setup", () => {
    expect(isTestFile("src/__tests__/a.ts")).toBe(true)
    expect(isTestFile("packages/x/test/a.js")).toBe(true)
    expect(isTestFile("src/a.spec.tsx")).toBe(true)
    expect(isTestFile("e2e/login.ts")).toBe(true)
    expect(isTestFile("vitest.setup.ts")).toBe(true)
    expect(isTestFile("src/testing.ts")).toBe(false)
    expect(isTestFile("src/contest/a.ts")).toBe(false)
  })
})

describe("splitOf", () => {
  it("gives a case the same set on every call", () => {
    expect(splitOf("o/r", 12)).toBe(splitOf("o/r", 12))
  })

  it("locks about one case in five", () => {
    let locked = 0
    for (let i = 0; i < 2000; i++)
      if (splitOf(`owner/repo${i % 37}`, i) === "locked") locked++
    expect(Math.abs(locked / 2000 - LOCKED_PERCENT / 100)).toBeLessThan(0.03)
  })
})

describe("repositoryKey", () => {
  it("reduces the forms of a GitHub repository to owner/name", () => {
    expect(
      repositoryKey({
        url: "git+https://github.com/getsentry/sentry-javascript.git",
        directory: "packages/node",
      })
    ).toBe("getsentry/sentry-javascript")
    expect(repositoryKey("github:nrwl/nx")).toBe("nrwl/nx")
    expect(repositoryKey("git@github.com:vitest-dev/vitest.git")).toBe(
      "vitest-dev/vitest"
    )
    expect(repositoryKey(undefined)).toBeUndefined()
  })
})

describe("releaseGroups", () => {
  it("joins the packages of one repository into one release", () => {
    const groups = releaseGroups(
      [
        up("@sentry/node", "9.0.0", "10.0.0"),
        up("@sentry/react", "9.0.0", "10.0.0"),
        up("zod", "3.0.0", "4.0.0"),
      ],
      new Map([
        ["@sentry/node", "getsentry/sentry-javascript"],
        ["@sentry/react", "getsentry/sentry-javascript"],
        ["zod", "colinhacks/zod"],
      ])
    )
    expect(groups).toEqual([["@sentry/node", "@sentry/react"], ["zod"]])
  })

  it("falls back on the scope and the new version without a repository", () => {
    const groups = releaseGroups(
      [
        up("@nx/js", "23.1.3", "23.2.0"),
        up("@nx/vite", "23.1.3", "23.2.0"),
        up("@nx/old", "22.0.0", "22.0.1"),
      ],
      new Map()
    )
    expect(groups).toHaveLength(2)
  })
})
