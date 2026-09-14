import { join } from "node:path"
import { createHash } from "node:crypto"

import { readJson, writeJson } from "./store.ts"

export interface Pool {
  limit: number
  remaining: number
  // epoch seconds
  reset: number
}

export type PoolName = "core" | "graphql" | "search"

export class BudgetError extends Error {}

// Enough to stop before the budget others share runs dry, with the time it comes back.
export function budgetMessage(
  name: PoolName,
  pool: Pool,
  keep: number
): string | undefined {
  if (pool.remaining >= keep) return undefined
  const at = new Date(pool.reset * 1000).toISOString().slice(11, 16)
  return `GitHub ${name} budget is ${pool.remaining}, under --keep ${keep}; it resets at ${at} UTC. Run the command again then: it resumes where it stopped.`
}

export interface GitHubOptions {
  token: string
  // every response is kept here, so a second run reads instead of asking again
  cacheDir: string
  keep: number
  log: (line: string) => void
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

// GitHub's search allows 30 requests a minute; GraphQL search counts against the same limiter.
const SEARCH_INTERVAL_MS = 2_100

const sleepReal = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export class GitHub {
  private readonly opts: GitHubOptions
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private lastSearch = 0
  private pools: Partial<Record<PoolName, Pool>> = {}
  requests = 0

  constructor(opts: GitHubOptions) {
    this.opts = opts
    this.fetch = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? sleepReal
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "dep-radius-corpus",
    }
  }

  // The lower of two readings: /rate_limit, which is free, and the headers of a one-request probe.
  // /rate_limit alone is not trusted: it has been seen answering a full budget while the headers of
  // every other response said hundreds of requests were spent.
  async probe(name: "core" | "graphql"): Promise<Pool> {
    const res = await this.fetch("https://api.github.com/rate_limit", {
      headers: this.headers(),
    })
    const listed = res.ok
      ? ((await res.json()) as { resources: Record<PoolName, Pool> }).resources[
          name
        ]
      : undefined
    this.requests++
    const probe =
      name === "core"
        ? await this.fetch("https://api.github.com/user", {
            method: "HEAD",
            headers: this.headers(),
          })
        : await this.fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: { ...this.headers(), "content-type": "application/json" },
            body: JSON.stringify({ query: "{ rateLimit { remaining } }" }),
          })
    const seen = poolFrom(probe.headers)
    const readings = [listed, seen].filter((p): p is Pool => !!p)
    if (readings.length === 0)
      throw new Error(`GitHub gave no ${name} budget reading`)
    const pool = readings.reduce((a, b) => (b.remaining < a.remaining ? b : a))
    this.pools[name] = pool
    return pool
  }

  // Throws a BudgetError when `name` is under --keep: a caller stops cleanly on it. `fresh` reads
  // the budget again, for a pool spent by someone else than this client, such as radius itself.
  async ensure(
    name: "core" | "graphql",
    opts: { fresh?: boolean } = {}
  ): Promise<Pool> {
    const known = this.pools[name]
    const pool = known && !opts.fresh ? known : await this.probe(name)
    if (!budgetMessage(name, pool, this.opts.keep)) return pool
    // a reading from this client's own last response may predate a reset
    const again = pool === known && !opts.fresh ? await this.probe(name) : pool
    const msg = budgetMessage(name, again, this.opts.keep)
    if (msg) throw new BudgetError(msg)
    return again
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    opts: { search?: boolean } = {}
  ): Promise<T> {
    const key = createHash("sha1")
      .update(query)
      .update("\0")
      .update(JSON.stringify(variables))
      .digest("hex")
    const file = join(this.opts.cacheDir, "graphql", `${key}.json`)
    const cached = readJson<{ data: T }>(file)
    if (cached) return cached.data

    for (let attempt = 1; ; attempt++) {
      await this.ensure("graphql")
      if (opts.search) {
        const wait = this.lastSearch + SEARCH_INTERVAL_MS - Date.now()
        if (wait > 0) await this.sleep(wait)
        this.lastSearch = Date.now()
      }
      this.requests++
      const res = await this.fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      })
      this.track("graphql", res.headers)
      if (res.status === 403 || res.status === 429) {
        const text = await res.text()
        const retryAfter = Number(res.headers.get("retry-after") ?? "60")
        if (/secondary rate limit/i.test(text) && attempt <= 2) {
          this.opts.log(
            `GitHub asked to slow down; waiting ${retryAfter}s before retrying`
          )
          await this.sleep(retryAfter * 1000)
          continue
        }
        throw new BudgetError(
          `GitHub refused the request (HTTP ${res.status}): ${text.slice(0, 200)}`
        )
      }
      // a heavy search page times out on GitHub's side now and then
      if (res.status >= 500 && attempt <= 3) {
        this.opts.log(`GitHub answered ${res.status}; retrying`)
        await this.sleep(5_000 * attempt)
        continue
      }
      if (!res.ok)
        throw new Error(`GitHub GraphQL: HTTP ${res.status}`, {
          cause: await res.text(),
        })
      const body = (await res.json()) as {
        data?: T
        errors?: { type?: string; message: string }[]
      }
      if (body.errors?.length || !body.data)
        throw new Error(
          `GitHub GraphQL: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`
        )
      writeJson(file, { data: body.data })
      return body.data
    }
  }

  private track(name: PoolName, headers: Headers): void {
    const pool = poolFrom(headers)
    if (pool) this.pools[name] = pool
  }
}

function poolFrom(headers: Headers): Pool | undefined {
  const remaining = headers.get("x-ratelimit-remaining")
  const limit = headers.get("x-ratelimit-limit")
  const reset = headers.get("x-ratelimit-reset")
  if (!remaining || !limit || !reset) return undefined
  return {
    remaining: Number(remaining),
    limit: Number(limit),
    reset: Number(reset),
  }
}
