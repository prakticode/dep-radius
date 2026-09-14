import type { Ctx } from "../../options.ts"
import { diffImplementations } from "./diff.ts"
import { integrityHex } from "../../infra/hash.ts"
import { type Flavor, flavorFor } from "./entries.ts"
import { buildImplementationFacts } from "./graph.ts"
import { getTarballFiles } from "../../registry/tarball.ts"
import type { RegistryConfig } from "../../registry/npmrc.ts"
import type { Packument, PackumentVersion } from "../../registry/packument.ts"
import {
  IMPLEMENTATION_ALGO,
  type ImplementationDiff,
  type ImplementationFacts,
  type ImplementationResult,
} from "./model.ts"

// The implementation facts of one published version, computed once and cached by the tarball's
// integrity, as type surfaces are: the same bytes always give the same facts.
export async function getImplementationFacts(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  version: string,
  flavor: Flavor
): Promise<ImplementationResult> {
  const pv = p.versions[version]
  if (!pv)
    return {
      ok: false,
      reason: "failed",
      detail: `version ${version} not in registry`,
    }
  const integrity = pv.dist.integrity ?? pv.dist.shasum ?? pv.dist.tarball
  const id =
    integrityHex(integrity) ??
    Buffer.from(integrity).toString("hex").slice(0, 64)
  const key = `implementation/${id}.a${IMPLEMENTATION_ALGO}.${flavor}.json`
  const cached = await ctx.cache.getJson<ImplementationResult>(key)
  if (cached) return cached.value

  const tb = await getTarballFiles(ctx, cfg, pv, "runtime")
  if (!tb.ok)
    return {
      ok: false,
      reason: tb.reason === "offline-uncached" ? "offline-uncached" : "failed",
      detail: tb.reason,
    }
  const result = await ctx.heavy(async () =>
    buildImplementationFacts(p.name, version, integrity, tb.files, flavor)
  )
  await ctx.cache.setJson(key, result, ctx.now)
  return result
}

export type DiffResult =
  | { ok: true; diff: ImplementationDiff }
  | { ok: false; reason: string; detail?: string }

export type PairResult =
  | {
      ok: true
      from: ImplementationFacts
      to: ImplementationFacts
      diff: ImplementationDiff
    }
  | { ok: false; reason: string; detail?: string }

// Both versions read through the same build, chosen from what the registry says they publish.
export async function getImplementationPair(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  from: string,
  to: string
): Promise<PairResult> {
  const a = p.versions[from]
  const b = p.versions[to]
  if (!a || !b)
    return { ok: false, reason: "failed", detail: "version missing" }
  const flavor = flavorFor(manifestOf(a), manifestOf(b))
  const [fa, fb] = await Promise.all([
    getImplementationFacts(ctx, cfg, p, from, flavor),
    getImplementationFacts(ctx, cfg, p, to, flavor),
  ])
  if (!fa.ok) return fa
  if (!fb.ok) return fb
  return {
    ok: true,
    from: fa.facts,
    to: fb.facts,
    diff: diffImplementations(fa.facts, fb.facts),
  }
}

export async function getImplementationDiff(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  from: string,
  to: string
): Promise<DiffResult> {
  const pair = await getImplementationPair(ctx, cfg, p, from, to)
  return pair.ok ? { ok: true, diff: pair.diff } : pair
}

function manifestOf(pv: PackumentVersion): Record<string, unknown> {
  return pv as unknown as Record<string, unknown>
}
