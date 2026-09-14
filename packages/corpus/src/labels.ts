import { createHash } from "node:crypto"

import semver from "semver"

import type { Upgrade } from "./case.ts"

export type Bump = "patch" | "minor" | "major"

// The largest step among the upgrades. A 0.x minor is a major under semver's caret rules, and a
// 0.0.x patch too: that is how npm and radius treat them.
export function bumpOf(packages: Upgrade[]): Bump {
  let out: Bump = "patch"
  for (const p of packages) {
    const from = semver.parse(p.from)
    const to = semver.parse(p.to)
    if (!from || !to) continue
    const kind: Bump =
      to.major !== from.major
        ? "major"
        : from.major === 0 && to.minor !== from.minor
          ? "major"
          : from.major === 0 && from.minor === 0 && to.patch !== from.patch
            ? "major"
            : to.minor !== from.minor
              ? "minor"
              : "patch"
    if (kind === "major") return kind
    if (kind === "minor") out = kind
  }
  return out
}

const TEST_FILE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|specs?|e2e|cypress|playwright|__snapshots__)\/|\.(?:test|spec|e2e|cy|stories)\.[cm]?[jt]sx?$|(?:^|\/)(?:vitest|jest|playwright)\.(?:setup|config)[^/]*$/i

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path)
}

export type SplitName = "working" | "locked"

// The share of cases set aside, never read while radius is being improved: the score on them is
// the one that says whether a change generalises.
export const LOCKED_PERCENT = 20

// A hash of the repository and the pull request number, not of anything mined, so a case lands in
// the same set on every machine and every run.
export function splitOf(repo: string, pr: number): SplitName {
  const h = createHash("sha256").update(`${repo}#${pr}`).digest()
  return h.readUInt32BE(0) % 100 < LOCKED_PERCENT ? "locked" : "working"
}
