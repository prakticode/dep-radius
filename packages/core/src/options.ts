import type { Logger } from "./infra/log.ts"
import type { Limiter } from "./infra/limit.ts"
import type { DiskCache } from "./infra/cache.ts"
import type { HttpClient } from "./infra/http.ts"

export type Format = "terminal" | "json" | "markdown"

export interface Options {
  root: string
  specs: string[]
  format: Format
  offline: boolean
  minAgeMs: number | undefined
  latest: boolean
  notes: boolean
  surface: boolean
  prod: boolean
  concurrency: number
  cacheDir: string
  verbose: boolean
  now: number
  color: boolean
}

// What run() reports while it works, for a progress display. Nothing in the result depends on it.
export type RunEvent =
  | { type: "files"; done: number; total: number }
  | { type: "packages"; total: number }
  | { type: "package-start"; name: string }
  | { type: "package"; name: string; done: number; total: number }

export interface Ctx {
  http: HttpClient
  cache: DiskCache
  now: number
  offline: boolean
  log: Logger
  net: Limiter
  github: Limiter
  heavy: Limiter
  githubToken: () => Promise<string | undefined>
  // read once where the command starts; nothing below cli.ts, context.ts or debug.ts touches process.env
  env: NodeJS.ProcessEnv
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

// "0", "90m", "36h", "7d"; a bare number is minutes, as pnpm's minimumReleaseAge is.
export function parseDuration(input: string): number {
  const s = input.trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 60_000
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h|d|w)$/i.exec(s)
  if (!m?.[1] || !m[2]) throw new Error(`invalid duration: ${input}`)
  return Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? 0)
}

export function formatAge(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

export const DEFAULT_MIN_AGE_MS = 86_400_000
