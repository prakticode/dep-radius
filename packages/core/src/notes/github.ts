import type { Ctx } from "../options.ts"
import { safeKey } from "../infra/cache.ts"
import type { RepoRef } from "./repo-url.ts"
import { OfflineError } from "../infra/http.ts"

export interface Release {
  tag: string
  body: string
}

export type Fetched<T> =
  | { ok: true; value: T }
  | {
      ok: false
      reason: "offline" | "rate-limited" | "http-error" | "not-found"
    }

const PAGE_TTL = 60 * 60 * 1000
const BODY_TTL = 24 * 60 * 60 * 1000
const MISS_TTL = 6 * 60 * 60 * 1000

export const githubState = { rateLimited: false, usedToken: false }

async function apiGet<T>(
  ctx: Ctx,
  path: string,
  ttl: number,
  missTtl: number
): Promise<Fetched<T>> {
  const key = `github/${safeKey(path)}.json`
  const cached = await ctx.cache.getJson<{ found: boolean; data?: T }>(key)
  if (
    cached &&
    (ctx.offline ||
      ctx.now - cached.storedAt < (cached.value.found ? ttl : missTtl))
  ) {
    return cached.value.found
      ? { ok: true, value: cached.value.data as T }
      : { ok: false, reason: "not-found" }
  }
  if (ctx.offline) return { ok: false, reason: "offline" }
  if (githubState.rateLimited) return { ok: false, reason: "rate-limited" }
  const token = await ctx.githubToken()
  if (token) githubState.usedToken = true
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dep-radius",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
  try {
    const res = await ctx.github(() =>
      ctx.http.get({ url: `https://api.github.com${path}`, headers })
    )
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers["x-ratelimit-remaining"] === "0"
    ) {
      githubState.rateLimited = true
      return { ok: false, reason: "rate-limited" }
    }
    if (res.status === 404) {
      await ctx.cache.setJson(key, { found: false }, ctx.now)
      return { ok: false, reason: "not-found" }
    }
    if (res.status !== 200) return { ok: false, reason: "http-error" }
    const data = JSON.parse(res.body.toString("utf8")) as T
    await ctx.cache.setJson(key, { found: true, data }, ctx.now)
    return { ok: true, value: data }
  } catch (error) {
    if (cached?.value.found) return { ok: true, value: cached.value.data as T }
    return {
      ok: false,
      reason: error instanceof OfflineError ? "offline" : "http-error",
    }
  }
}

type ApiRelease = { tag_name: string; body: string | null; draft: boolean }

export async function releasesPage(
  ctx: Ctx,
  repo: RepoRef
): Promise<Fetched<Release[]>> {
  const r = await apiGet<ApiRelease[]>(
    ctx,
    `/repos/${repo.owner}/${repo.repo}/releases?per_page=100`,
    PAGE_TTL,
    PAGE_TTL
  )
  if (!r.ok) return r
  return {
    ok: true,
    value: r.value
      .filter((x) => !x.draft)
      .map((x) => ({ tag: x.tag_name, body: x.body ?? "" })),
  }
}

export async function releaseByTag(
  ctx: Ctx,
  repo: RepoRef,
  tag: string
): Promise<Fetched<Release>> {
  const r = await apiGet<ApiRelease>(
    ctx,
    `/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`,
    BODY_TTL,
    MISS_TTL
  )
  if (!r.ok) return r
  return {
    ok: true,
    value: { tag: r.value.tag_name, body: r.value.body ?? "" },
  }
}

// raw.githubusercontent.com costs no API quota.
export async function rawChangelog(
  ctx: Ctx,
  repo: RepoRef
): Promise<Fetched<{ url: string; text: string }>> {
  const dirs = [...new Set([repo.directory, undefined])]
  const names = ["CHANGELOG.md", "HISTORY.md", "History.md", "CHANGES.md"]
  let sawError: Fetched<never> | undefined
  for (const dir of dirs) {
    for (const name of names) {
      const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${dir ? `${dir}/` : ""}${name}`
      const key = `raw/${safeKey(url)}.json`
      const cached = await ctx.cache.getJson<{ found: boolean; text?: string }>(
        key
      )
      if (
        cached &&
        (ctx.offline ||
          ctx.now - cached.storedAt <
            (cached.value.found ? BODY_TTL : MISS_TTL))
      ) {
        if (cached.value.found)
          return { ok: true, value: { url, text: cached.value.text ?? "" } }
        continue
      }
      if (ctx.offline) {
        sawError = { ok: false, reason: "offline" }
        continue
      }
      try {
        const res = await ctx.net(() =>
          ctx.http.get({ url, headers: { "user-agent": "dep-radius" } })
        )
        if (res.status === 200) {
          const text = res.body.toString("utf8")
          await ctx.cache.setJson(key, { found: true, text }, ctx.now)
          return { ok: true, value: { url, text } }
        }
        if (res.status === 404)
          await ctx.cache.setJson(key, { found: false }, ctx.now)
        else sawError = { ok: false, reason: "http-error" }
      } catch (error) {
        sawError = {
          ok: false,
          reason: error instanceof OfflineError ? "offline" : "http-error",
        }
      }
    }
  }
  return sawError ?? { ok: false, reason: "not-found" }
}

// Fixed order: an index into this list is the "scheme" learned from a repository's tags.
export function tagCandidates(pkg: string, version: string): string[] {
  const unscoped = pkg.includes("/") ? pkg.split("/")[1]! : pkg
  return [
    `v${version}`,
    version,
    `${pkg}@${version}`,
    `${unscoped}@${version}`,
    `${pkg}-v${version}`,
    `${unscoped}-v${version}`,
    `release-${version}`,
  ]
}
