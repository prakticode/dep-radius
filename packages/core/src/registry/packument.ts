import type { Ctx } from "../options.ts"
import { safeKey } from "../infra/cache.ts"
import { OfflineError } from "../infra/http.ts"
import { authHeaders, type RegistryConfig, registryFor } from "./npmrc.ts"

export interface PackumentVersion {
  version: string
  deprecated?: string
  dist: { tarball: string; integrity?: string; shasum?: string }
  types?: string
  typings?: string
  exports?: unknown
  typesVersions?: Record<string, Record<string, string[]>>
  repository?: unknown
  bin?: unknown
}

export interface Packument {
  name: string
  "dist-tags": Record<string, string>
  time: Record<string, string>
  repository?: unknown
  versions: Record<string, PackumentVersion>
}

export type PackumentResult =
  | { ok: true; packument: Packument }
  | {
      ok: false
      reason: "not-found" | "unpublished" | "offline-uncached" | "http-error"
      detail?: string
    }

const FRESH_MS = 60 * 60 * 1000

// The full document, because the abbreviated one has no `time`, `repository`, `types` or `exports`.
export async function getPackument(
  ctx: Ctx,
  cfg: RegistryConfig,
  name: string
): Promise<PackumentResult> {
  const key = `packuments/${safeKey(name)}.json`
  const cached = await ctx.cache.getJson<{
    etag?: string
    packument: Packument
  }>(key)
  if (cached && (ctx.offline || ctx.now - cached.storedAt < FRESH_MS))
    return { ok: true, packument: cached.value.packument }
  if (ctx.offline) return { ok: false, reason: "offline-uncached" }

  const url = `${registryFor(cfg, name)}/${name.replace("/", "%2f")}`
  const headers: Record<string, string> = {
    accept: "application/json",
    ...authHeaders(cfg, url),
  }
  if (cached?.value.etag) headers["if-none-match"] = cached.value.etag
  try {
    const res = await ctx.net(() => ctx.http.get({ url, headers }))
    if (res.status === 304 && cached) {
      await ctx.cache.setJson(key, cached.value, ctx.now)
      return { ok: true, packument: cached.value.packument }
    }
    if (res.status === 404) return { ok: false, reason: "not-found" }
    if (res.status !== 200) {
      if (cached) return { ok: true, packument: cached.value.packument }
      return { ok: false, reason: "http-error", detail: `HTTP ${res.status}` }
    }
    const full = JSON.parse(res.body.toString("utf8")) as Record<
      string,
      unknown
    >
    const packument = trim(full)
    if (!packument.versions || Object.keys(packument.versions).length === 0) {
      return {
        ok: false,
        reason: packument.time?.unpublished ? "unpublished" : "not-found",
      }
    }
    await ctx.cache.setJson(key, { etag: res.headers.etag, packument }, ctx.now)
    return { ok: true, packument }
  } catch (error) {
    if (cached) return { ok: true, packument: cached.value.packument }
    if (error instanceof OfflineError)
      return { ok: false, reason: "offline-uncached" }
    return { ok: false, reason: "http-error", detail: String(error) }
  }
}

function trim(full: Record<string, unknown>): Packument {
  const versions: Record<string, PackumentVersion> = {}
  for (const [v, raw] of Object.entries(
    (full.versions ?? {}) as Record<string, Record<string, unknown>>
  )) {
    const dist = (raw.dist ?? {}) as PackumentVersion["dist"]
    const pv: PackumentVersion = {
      version: v,
      dist: {
        tarball: dist.tarball,
        integrity: dist.integrity,
        shasum: dist.shasum,
      },
    }
    if (typeof raw.deprecated === "string" && raw.deprecated)
      pv.deprecated = raw.deprecated
    if (typeof raw.types === "string") pv.types = raw.types
    if (typeof raw.typings === "string") pv.typings = raw.typings
    if (raw.exports !== undefined) pv.exports = raw.exports
    if (raw.typesVersions)
      pv.typesVersions = raw.typesVersions as PackumentVersion["typesVersions"]
    if (raw.repository !== undefined) pv.repository = raw.repository
    versions[v] = pv
  }
  return {
    name: String(full.name),
    "dist-tags": (full["dist-tags"] ?? {}) as Record<string, string>,
    time: (full.time ?? {}) as Record<string, string>,
    repository: full.repository,
    versions,
  }
}
