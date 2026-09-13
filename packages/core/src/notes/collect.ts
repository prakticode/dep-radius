import semver from "semver"

import type { Ctx } from "../options.ts"
import { splitEntries } from "./entries.ts"
import { parseRepository } from "./repo-url.ts"
import { changelogSections } from "./changelog.ts"
import type { Packument } from "../registry/packument.ts"
import type { RegistryConfig } from "../registry/npmrc.ts"
import { CHANGELOG_FILE, getTarballFiles } from "../registry/tarball.ts"
import type {
  Candidate,
  NoteEntry,
  NotesCoverage,
  NoteSourceKind,
  VersionNotes,
} from "../model.ts"
import {
  githubState,
  rawChangelog,
  type Release,
  releaseByTag,
  releasesPage,
  tagCandidates,
} from "./github.ts"

export interface CollectedNotes {
  perVersion: VersionNotes[]
  entries: NoteEntry[]
  coverage: NotesCoverage
}

const MAX_TAG_LOOKUPS = 12

export async function collectNotes(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  c: Candidate
): Promise<CollectedNotes> {
  const versions = c.range
  const bodies = new Map<
    string,
    { kind: NoteSourceKind; url: string; body: string }
  >()
  const failures = new Map<string, NonNullable<VersionNotes["reason"]>>()
  const missing = () => versions.filter((v) => !bodies.has(v))
  // a major lists its breaking changes in its betas more often than in its x.0.0: read them wherever
  // a source is already open, never at the cost of a request, and never counted in the coverage
  const pre = prereleasesIn(p, versions)
  const preBodies = new Map<string, string>()
  const takePre = (sections: Map<string, string>) => {
    for (const v of pre) {
      const body = sections.get(v)
      if (body?.trim() && !preBodies.has(v)) preBodies.set(v, body)
    }
  }

  // 1. a changelog shipped inside the target tarball covers every version up to it, for free
  const target = p.versions[c.to]
  if (target) {
    const tb = await getTarballFiles(ctx, cfg, target)
    if (tb.ok) {
      for (const [path, buf] of tb.files) {
        if (!CHANGELOG_FILE.test(path)) continue
        const sections = changelogSections(buf.toString("utf8"))
        takePre(sections)
        for (const v of missing()) {
          const body = sections.get(v)
          if (body !== undefined && body.trim())
            bodies.set(v, {
              kind: "tarball-changelog",
              url: `${c.pkg}@${c.to}/${path}`,
              body,
            })
        }
      }
    } else if (tb.reason === "offline-uncached") {
      for (const v of missing()) failures.set(v, "offline")
    }
  }

  // 2. GitHub releases
  const repo = parseRepository(target?.repository ?? p.repository)
  let repoReachable = false
  if (missing().length > 0) {
    if (!repo) for (const v of missing()) failures.set(v, "no-repo")
    else if (repo.host !== "github")
      for (const v of missing()) failures.set(v, "unsupported-host")
    else {
      const page = await releasesPage(ctx, repo)
      if (page.ok) {
        repoReachable = true
        const byTag = new Map(page.value.map((r) => [r.tag, r]))
        let scheme: number | undefined
        for (const v of versions) {
          const cands = tagCandidates(c.pkg, v)
          const hit = cands.findIndex((t) => byTag.has(t))
          if (hit >= 0) {
            scheme ??= hit
            const rel = byTag.get(cands[hit]!)!
            if (!bodies.has(v)) acceptRelease(v, rel, repo.owner, repo.repo)
          }
        }
        for (const v of pre) {
          const rel = tagCandidates(c.pkg, v)
            .map((t) => byTag.get(t))
            .find(Boolean)
          if (rel && !preBodies.has(v) && !isPointerOnly(rel.body))
            preBodies.set(v, rel.body)
        }
        // versions pushed off the first page: look them up by tag, with the scheme the page taught us
        let lookups = 0
        for (const v of missing()) {
          if (lookups >= MAX_TAG_LOOKUPS) break
          const cands = tagCandidates(c.pkg, v)
          const tries =
            scheme !== undefined ? [cands[scheme]!] : cands.slice(0, 3)
          for (const tag of tries) {
            lookups++
            const r = await releaseByTag(ctx, repo, tag)
            if (r.ok) {
              acceptRelease(v, r.value, repo.owner, repo.repo)
              break
            }
            if (r.reason !== "not-found") {
              failures.set(
                v,
                r.reason === "offline"
                  ? "offline"
                  : r.reason === "rate-limited"
                    ? "rate-limited"
                    : "http-error"
              )
              break
            }
          }
        }
      } else if (page.reason === "not-found") {
        repoReachable = true
      } else {
        for (const v of missing())
          failures.set(
            v,
            page.reason === "offline"
              ? "offline"
              : page.reason === "rate-limited"
                ? "rate-limited"
                : "http-error"
          )
      }

      // 3. the repository's changelog
      if (missing().length > 0) {
        const raw = await rawChangelog(ctx, repo)
        if (raw.ok) {
          repoReachable = true
          const sections = changelogSections(raw.value.text)
          takePre(sections)
          for (const v of missing()) {
            const body = sections.get(v)
            if (body !== undefined && body.trim()) {
              bodies.set(v, {
                kind: "repo-changelog",
                url: raw.value.url,
                body,
              })
              failures.delete(v)
            }
          }
        } else if (raw.reason === "not-found") {
          repoReachable = true
        }
      }
    }
  }

  function acceptRelease(v: string, r: Release, owner: string, name: string) {
    if (isPointerOnly(r.body)) {
      failures.set(v, "stub-body")
      return
    }
    bodies.set(v, {
      kind: "github-release",
      url: `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(r.tag)}`,
      body: r.body,
    })
    failures.delete(v)
  }

  const perVersion: VersionNotes[] = versions.map((v) => {
    const b = bodies.get(v)
    if (b)
      return {
        version: v,
        status: "found",
        source: { kind: b.kind, url: b.url },
      }
    const reason = failures.get(v)
    if (reason && reason !== "stub-body")
      return { version: v, status: "unavailable", reason }
    return repoReachable || reason === "stub-body"
      ? { version: v, status: "not-published", ...(reason ? { reason } : {}) }
      : {
          version: v,
          status: "unavailable",
          reason:
            reason ?? (githubState.rateLimited ? "rate-limited" : "no-repo"),
        }
  })

  const entries = [...versions, ...preBodies.keys()]
    .sort(semver.compare)
    .flatMap((v) => {
      const body = bodies.get(v)?.body ?? preBodies.get(v)
      return body ? splitEntries(v, body) : []
    })
  const found = perVersion.filter((x) => x.status === "found").length
  const unavailable = perVersion.filter(
    (x) => x.status === "unavailable"
  ).length
  let coverage: NotesCoverage
  if (versions.length === 0 || found === versions.length) coverage = "complete"
  else if (found > 0) coverage = "partial"
  else if (unavailable > 0) coverage = "unavailable"
  else coverage = "none-published"
  return { perVersion, entries, coverage }
}

// "**Change log available at** <link>" and GitHub's "**Full Changelog**: v1...v2" read as notes and
// say nothing. Counted as found, they let a major release pass as quiet on no information, so a
// body is a pointer once its links are gone and what is left only points elsewhere.
export function isPointerOnly(body: string): boolean {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*\**\s*full changelog\s*\**\s*:?.*$/gim, "")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return true
  return (
    text.length < 120 &&
    /change ?log|release notes|see |available (at|on|here)|upgrade guide|migration guide|blog post|details/i.test(
      text
    )
  )
}

const PRERELEASE_TAG = /^(alpha|beta|rc|pre|preview)$/i

// Betas, release candidates and alphas of the stable versions in range. Canaries, nightlies and
// dated builds are left out: a busy package publishes hundreds of them.
export function prereleasesIn(p: Packument, stable: string[]): string[] {
  const inRange = new Set(stable)
  return Object.keys(p.versions)
    .filter((v) => {
      const tags = semver.prerelease(v)
      if (!tags || !PRERELEASE_TAG.test(String(tags[0]))) return false
      return inRange.has(
        `${semver.major(v)}.${semver.minor(v)}.${semver.patch(v)}`
      )
    })
    .sort(semver.compare)
    .slice(-20)
}
