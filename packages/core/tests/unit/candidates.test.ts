import { describe, expect, it } from "vitest"

import type { Packument } from "../../src/registry/packument.ts"
import { bumpOf, selectCandidate } from "../../src/registry/candidates.ts"

const NOW = Date.parse("2026-09-13T09:00:00Z")
const DAY = 86_400_000

function packument(
  versions: [string, string, { deprecated?: string }?][],
  latest?: string
): Packument {
  const p: Packument = { name: "x", "dist-tags": {}, time: {}, versions: {} }
  for (const [v, time, extra] of versions) {
    p.time[v] = time
    p.versions[v] = {
      version: v,
      dist: { tarball: "" },
      ...(extra?.deprecated ? { deprecated: extra.deprecated } : {}),
    }
  }
  p["dist-tags"].latest = latest ?? versions[versions.length - 1]![0]
  return p
}

const opts = {
  now: NOW,
  minAgeMs: DAY,
  ageExcluded: () => false,
  latest: false,
}

describe("selectCandidate", () => {
  it("skips prereleases, deprecated versions and anything younger than the cooldown", () => {
    const p = packument([
      ["4.5.4", "2026-08-29T17:55:42Z"],
      ["4.6.0-canary.1", "2026-09-01T00:00:00Z"],
      ["4.6.0", "2026-09-09T19:25:02Z"],
      ["4.6.1", "2026-09-09T21:50:12Z", { deprecated: "broken" }],
      ["4.6.2", "2026-09-10T21:44:31Z"],
      ["4.6.3", "2026-09-12T22:23:48Z"],
    ])
    const r = selectCandidate(p, "4.5.4", opts)
    expect(r.kind).toBe("candidate")
    if (r.kind !== "candidate") return
    expect(r.candidate.to).toBe("4.6.2")
    expect(r.candidate.range).toEqual(["4.6.0", "4.6.1", "4.6.2"])
    expect(r.candidate.skippedNewer.map((s) => [s.version, s.reason])).toEqual([
      ["4.6.3", "too-new"],
    ])
  })

  it("sorts by semver, never by publish time", () => {
    const p = packument([
      ["4.5.1", "2026-08-28T17:58:39Z"],
      ["4.5.0", "2026-08-28T18:14:39Z"],
      ["4.5.2", "2026-08-29T00:36:06Z"],
    ])
    const r = selectCandidate(p, "4.4.0", opts)
    expect(r.kind === "candidate" && r.candidate.range).toEqual([
      "4.5.0",
      "4.5.1",
      "4.5.2",
    ])
  })

  it("stays on the caret line and names the next major separately", () => {
    const p = packument(
      [
        ["4.19.2", "2024-03-25T00:00:00Z"],
        ["4.22.2", "2026-05-11T18:50:00Z"],
        ["5.2.1", "2026-06-01T00:00:00Z"],
      ],
      "5.2.1"
    )
    const r = selectCandidate(p, "4.19.2", opts)
    expect(
      r.kind === "candidate" && [
        r.candidate.to,
        r.candidate.bump,
        r.candidate.alsoAvailable,
      ]
    ).toEqual(["4.22.2", "minor", { version: "5.2.1", bump: "major" }])
    const latest = selectCandidate(p, "4.19.2", { ...opts, latest: true })
    expect(latest.kind === "candidate" && latest.candidate.to).toBe("5.2.1")
  })

  it("treats a 0.x minor as its own line", () => {
    const p = packument([
      ["0.45.1", "2026-01-01T00:00:00Z"],
      ["0.45.3", "2026-02-01T00:00:00Z"],
      ["0.46.0", "2026-03-01T00:00:00Z"],
    ])
    const r = selectCandidate(p, "0.45.1", opts)
    expect(
      r.kind === "candidate" && [
        r.candidate.to,
        r.candidate.alsoAvailable?.version,
      ]
    ).toEqual(["0.45.3", "0.46.0"])
    expect(bumpOf("0.45.1", "0.46.0")).toBe("major")
  })

  it("never goes above latest on the same line", () => {
    const p = packument(
      [
        ["2.0.0", "2026-01-01T00:00:00Z"],
        ["2.1.0", "2026-02-01T00:00:00Z"],
        ["2.2.0", "2026-03-01T00:00:00Z"],
      ],
      "2.1.0"
    )
    const r = selectCandidate(p, "2.0.0", opts)
    expect(r.kind === "candidate" && r.candidate.to).toBe("2.1.0")
  })

  it("honours an explicit version, a dist-tag, and the age exclusion list", () => {
    const p = packument([
      ["1.0.0", "2026-01-01T00:00:00Z"],
      ["1.1.0", "2026-09-13T08:00:00Z"],
    ])
    expect(selectCandidate(p, "1.0.0", opts).kind).toBe("up-to-date")
    expect(
      selectCandidate(p, "1.0.0", {
        ...opts,
        ageExcluded: (v) => v === "1.1.0",
      }).kind
    ).toBe("candidate")
    const explicit = selectCandidate(p, "1.0.0", {
      ...opts,
      explicit: "latest",
    })
    expect(explicit.kind === "candidate" && explicit.candidate.to).toBe("1.1.0")
  })
})
