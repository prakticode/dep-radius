import semver from "semver"

import { decide } from "./verdict.ts"
import { level0Names } from "../symbol-path.ts"
import type { MatchResult } from "../notes/match.ts"
import type { CollectedNotes } from "../notes/collect.ts"
import type {
  Candidate,
  InstalledDep,
  PackageBrief,
  PackageUsage,
  Site,
} from "../model.ts"

export interface BriefParts {
  dep: InstalledDep
  candidate: Candidate
  usage: PackageUsage | undefined
  surface: PackageBrief["surface"] & { incomplete?: boolean }
  notes: CollectedNotes | undefined
  match: MatchResult | undefined
  notesDisabled: boolean
}

export function buildPackageBrief(parts: BriefParts): PackageBrief {
  const { dep, candidate, usage, surface } = parts
  const notes: PackageBrief["notes"] = parts.notesDisabled
    ? {
        coverage: "disabled",
        perVersion: [],
        total: 0,
        matched: [],
        unattributedBreaking: [],
      }
    : {
        coverage: parts.notes?.coverage ?? "unavailable",
        perVersion: parts.notes?.perVersion ?? [],
        total: parts.match?.total ?? 0,
        matched: parts.match?.matched ?? [],
        unattributedBreaking: parts.match?.unattributedBreaking ?? [],
      }
  const from = semver.parse(candidate.from)
  const to = semver.parse(candidate.to)
  const zeroMajor =
    !!from &&
    !!to &&
    from.major === 0 &&
    to.major === 0 &&
    candidate.bump !== "patch"
  const { verdict, reasons } = decide({
    bump: candidate.bump,
    zeroMajor: zeroMajor && candidate.bump === "major",
    flags: dep.flags,
    usage,
    surface,
    notes,
  })
  const { incomplete: _i, ...surfaceOut } = surface
  return {
    pkg: dep.name,
    from: candidate.from,
    to: candidate.to,
    bump: candidate.bump,
    publishedAt: candidate.publishedAt,
    versionSource: dep.versionSource,
    manifests: [...new Set(dep.declaredBy.map((d) => d.manifest))].sort(),
    level: surface.status === "computed" ? 1 : 0,
    verdict,
    reasons,
    surface: surfaceOut,
    notes,
    usage: {
      files: usage?.files ?? 0,
      sites: uniqueSites(usage?.refs.map((r) => r.site) ?? []),
      byName: sitesByName(usage),
      strongNames: usage?.strongNames ?? [],
      weakNames: usage?.weakNames ?? [],
      opaque: usage?.opaque ?? [],
      blindSpots: usage?.blindSpots ?? [],
    },
    skippedNewer: candidate.skippedNewer,
    ...(candidate.alsoAvailable
      ? { alsoAvailable: candidate.alsoAvailable }
      : {}),
  }
}

export function sitesByName(
  usage: PackageUsage | undefined
): Record<string, Site[]> {
  const map = new Map<string, Site[]>()
  for (const r of usage?.refs ?? []) {
    const n = level0Names(r)
    for (const name of [...n.strong, ...n.weak]) {
      const list = map.get(name) ?? []
      list.push(r.site)
      map.set(name, list)
    }
  }
  const out: Record<string, Site[]> = {}
  for (const name of [...map.keys()].sort())
    out[name] = uniqueSites(map.get(name)!)
  return out
}

export function uniqueSites(sites: Site[]): Site[] {
  const seen = new Map<string, Site>()
  for (const s of sites) {
    const k = `${s.file}:${s.line}`
    const prev = seen.get(k)
    if (!prev || (prev.typeOnly && !s.typeOnly)) seen.set(k, s)
  }
  return [...seen.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  )
}
