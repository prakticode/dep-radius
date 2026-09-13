import { readTarball } from "./tar.ts"
import type { Ctx } from "../options.ts"
import { OfflineError } from "../infra/http.ts"
import type { PackumentVersion } from "./packument.ts"
import { authHeaders, type RegistryConfig } from "./npmrc.ts"
import { integrityHex, sha1, verifyIntegrity } from "../infra/hash.ts"

export const CHANGELOG_FILE =
  /^(changelog|changes|history|releases?|news)(\.(md|markdown|txt|rst))?$/i

export function isKeptFile(path: string): boolean {
  return (
    path === "package.json" ||
    /\.d\.[cm]?ts$/.test(path) ||
    CHANGELOG_FILE.test(path)
  )
}

export type TarballResult =
  | { ok: true; files: Map<string, Buffer>; integrity: string }
  | {
      ok: false
      reason: "offline-uncached" | "http-error" | "integrity-mismatch"
      detail?: string
    }

const memory = new Map<string, Promise<TarballResult>>()

export function getTarballFiles(
  ctx: Ctx,
  cfg: RegistryConfig,
  pv: PackumentVersion
): Promise<TarballResult> {
  const integrity =
    pv.dist.integrity ??
    (pv.dist.shasum
      ? `sha1-${Buffer.from(pv.dist.shasum, "hex").toString("base64")}`
      : "")
  const id = integrityHex(integrity) ?? sha1(pv.dist.tarball)
  let p = memory.get(id)
  if (!p) {
    p = load(ctx, cfg, pv, integrity, id)
    memory.set(id, p)
  }
  return p
}

async function load(
  ctx: Ctx,
  cfg: RegistryConfig,
  pv: PackumentVersion,
  integrity: string,
  id: string
): Promise<TarballResult> {
  const key = `tarballs/${id}.tgz`
  let bytes = await ctx.cache.getBytes(key)
  if (!bytes) {
    if (ctx.offline) return { ok: false, reason: "offline-uncached" }
    try {
      const res = await ctx.net(() =>
        ctx.http.get({
          url: pv.dist.tarball,
          headers: authHeaders(cfg, pv.dist.tarball),
        })
      )
      if (res.status !== 200)
        return { ok: false, reason: "http-error", detail: `HTTP ${res.status}` }
      if (integrity && !verifyIntegrity(res.body, integrity))
        return { ok: false, reason: "integrity-mismatch" }
      bytes = res.body
      await ctx.cache.setBytes(key, bytes)
    } catch (error) {
      if (error instanceof OfflineError)
        return { ok: false, reason: "offline-uncached" }
      return { ok: false, reason: "http-error", detail: String(error) }
    }
  }
  try {
    return { ok: true, files: readTarball(bytes, isKeptFile), integrity }
  } catch (error) {
    return {
      ok: false,
      reason: "http-error",
      detail: `unreadable tarball: ${String(error)}`,
    }
  }
}
