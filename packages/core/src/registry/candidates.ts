import semver from "semver"

import type { Packument } from "./packument.ts"
import type { Bump, Candidate } from "../model.ts"

export interface CandidateOptions {
  now: number
  minAgeMs: number
  ageExcluded: (version: string) => boolean
  latest: boolean
  explicit?: string
}

export type CandidateResult =
  | { kind: "candidate"; candidate: Candidate }
  | {
      kind: "up-to-date"
      skippedNewer: Candidate["skippedNewer"]
      alsoAvailable?: Candidate["alsoAvailable"]
    }
  | { kind: "error"; reason: string }

export function bumpOf(from: string, to: string): Bump {
  const a = semver.parse(from)
  const b = semver.parse(to)
  if (!a || !b) return "major"
  if (a.major !== b.major) return "major"
  if (a.major === 0 && a.minor !== b.minor) return "major"
  if (a.minor !== b.minor) return "minor"
  if (a.major === 0 && a.minor === 0 && a.patch !== b.patch) return "major"
  return "patch"
}

// The caret line of the installed version: what semver promises is safe.
function sameLine(installed: string, v: string): boolean {
  const a = semver.parse(installed)!
  const b = semver.parse(v)!
  if (a.major !== b.major) return false
  if (a.major > 0) return true
  if (a.minor !== b.minor) return false
  if (a.minor > 0) return true
  return a.patch === b.patch
}

export function stableRange(p: Packument, from: string, to: string): string[] {
  return Object.keys(p.versions)
    .filter(
      (v) =>
        semver.valid(v) &&
        !semver.prerelease(v) &&
        semver.gt(v, from) &&
        semver.lte(v, to)
    )
    .sort(semver.compare)
}

export function selectCandidate(
  p: Packument,
  installed: string,
  opts: CandidateOptions
): CandidateResult {
  if (!semver.valid(installed))
    return {
      kind: "error",
      reason: `installed version ${installed} is not semver`,
    }

  if (opts.explicit) {
    const target = p["dist-tags"][opts.explicit] ?? opts.explicit
    if (!p.versions[target])
      return {
        kind: "error",
        reason: `version ${opts.explicit} does not exist`,
      }
    if (semver.eq(target, installed))
      return { kind: "up-to-date", skippedNewer: [] }
    const from = semver.lt(target, installed) ? target : installed
    const to = semver.lt(target, installed) ? installed : target
    return {
      kind: "candidate",
      candidate: {
        pkg: p.name,
        from: installed,
        to: target,
        bump: bumpOf(from, to),
        publishedAt: p.time[target] ?? "",
        range: stableRange(p, from, to),
        skippedNewer: [],
      },
    }
  }

  const skipped: Candidate["skippedNewer"] = []
  const eligible: string[] = []
  const newer = Object.keys(p.versions)
    .filter(
      (v) => semver.valid(v) && !semver.prerelease(v) && semver.gt(v, installed)
    )
    .sort(semver.rcompare)
  for (const v of newer) {
    const pv = p.versions[v]!
    const published = p.time[v]
    if (pv.deprecated) {
      skipped.push({ version: v, reason: "deprecated" })
      continue
    }
    if (!published) continue
    const age = opts.now - Date.parse(published)
    if (age < opts.minAgeMs && !opts.ageExcluded(v)) {
      skipped.push({ version: v, reason: "too-new", publishedAt: published })
      continue
    }
    eligible.push(v)
  }

  const latestTag = p["dist-tags"].latest
  const onLine = eligible.filter((v) => sameLine(installed, v))
  const beyond = eligible.filter((v) => !sameLine(installed, v))

  let target: string | undefined
  if (opts.latest) {
    target = eligible[0]
  } else {
    target = onLine[0]
    // npm never installs above `latest` for a range, so neither does the brief
    if (
      target &&
      latestTag &&
      semver.valid(latestTag) &&
      sameLine(installed, latestTag) &&
      semver.gt(target, latestTag)
    ) {
      for (const v of onLine)
        if (semver.gt(v, latestTag))
          skipped.push({ version: v, reason: "above-dist-tag" })
      target = semver.gt(latestTag, installed) ? latestTag : undefined
    }
  }
  const skippedNewer = skipped
    .filter((s) => !target || semver.gt(s.version, target))
    .filter((s) => opts.latest || sameLine(installed, s.version))
    .sort((a, b) => semver.compare(a.version, b.version))
    .slice(0, 3)
  const above = opts.latest ? undefined : beyond[0]
  const alsoAvailable = above
    ? { version: above, bump: bumpOf(installed, above) }
    : undefined

  if (!target)
    return {
      kind: "up-to-date",
      skippedNewer,
      ...(alsoAvailable ? { alsoAvailable } : {}),
    }
  return {
    kind: "candidate",
    candidate: {
      pkg: p.name,
      from: installed,
      to: target,
      bump: bumpOf(installed, target),
      publishedAt: p.time[target] ?? "",
      range: stableRange(p, installed, target),
      skippedNewer,
      ...(alsoAvailable ? { alsoAvailable } : {}),
    },
  }
}
