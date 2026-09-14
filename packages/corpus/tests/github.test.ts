import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { days } from "../src/mine.ts"
import { BudgetError, budgetMessage, GitHub } from "../src/github.ts"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// /rate_limit always claims a full budget, as it has been seen doing; the probes' headers carry
// the real one.
function fakeFetch(seen: { core: number; graphql: number }) {
  const calls: string[] = []
  const limits = (remaining: number) => ({
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-limit": "5000",
    "x-ratelimit-reset": "0",
  })
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url
    const body = typeof init?.body === "string" ? init.body : ""
    const probe = body.includes("rateLimit")
    calls.push(probe ? `${u} probe` : u)
    if (u.endsWith("/rate_limit"))
      return Response.json({
        resources: {
          core: { limit: 5000, remaining: 5000, reset: 0 },
          graphql: { limit: 5000, remaining: 5000, reset: 0 },
          search: { limit: 30, remaining: 30, reset: 0 },
        },
      })
    if (u.endsWith("/user"))
      return new Response(null, { headers: limits(seen.core) })
    return Response.json(
      { data: { ok: true } },
      { headers: limits(seen.graphql) }
    )
  }) as typeof fetch
  return { calls, impl }
}

function client(fetchImpl: typeof fetch, keep = 500) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-gh-"))
  dirs.push(dir)
  return new GitHub({
    token: "t",
    cacheDir: dir,
    keep,
    log: () => {},
    fetch: fetchImpl,
    sleep: async () => {},
  })
}

describe("budgetMessage", () => {
  it("stays silent while the budget is at or above what must be kept", () => {
    expect(
      budgetMessage("core", { limit: 5000, remaining: 500, reset: 0 }, 500)
    ).toBeUndefined()
  })

  it("names the pool, the budget left and when it resets", () => {
    expect(
      budgetMessage(
        "graphql",
        {
          limit: 5000,
          remaining: 12,
          reset: Date.UTC(2026, 0, 1, 13, 45) / 1000,
        },
        500
      )
    ).toMatch(/graphql budget is 12, under --keep 500; it resets at 13:45 UTC/)
  })
})

describe("GitHub", () => {
  it("answers a repeated query from the disk cache", async () => {
    const f = fakeFetch({ core: 4000, graphql: 4000 })
    const gh = client(f.impl)
    await gh.graphql("{ a }", { x: 1 })
    await gh.graphql("{ a }", { x: 1 })
    expect(f.calls.filter((c) => c.endsWith("/graphql"))).toHaveLength(1)
  })

  it("trusts the lower reading when /rate_limit claims a full budget", async () => {
    const gh = client(fakeFetch({ core: 1200, graphql: 4000 }).impl, 1500)
    expect((await gh.probe("core")).remaining).toBe(1200)
    await expect(gh.ensure("core", { fresh: true })).rejects.toBeInstanceOf(
      BudgetError
    )
  })

  it("stops before a request once the budget is under --keep", async () => {
    const f = fakeFetch({ core: 4000, graphql: 100 })
    const gh = client(f.impl)
    await expect(gh.graphql("{ a }", {})).rejects.toBeInstanceOf(BudgetError)
    expect(f.calls.filter((c) => c.endsWith("/graphql"))).toHaveLength(0)
  })

  it("reads the budget again before stopping on a reading it made itself", async () => {
    const seen = { core: 4000, graphql: 4000 }
    const f = fakeFetch(seen)
    const gh = client(f.impl)
    await gh.graphql("{ a }", {})
    // the last response said 100 left, and the budget has reset since
    seen.graphql = 100
    await gh.graphql("{ b }", {})
    seen.graphql = 5000
    await expect(gh.ensure("graphql")).resolves.toMatchObject({
      remaining: 5000,
    })
  })
})

describe("days", () => {
  it("walks merge dates from the newest to the oldest", () => {
    expect(days("2026-02-27", "2026-03-01")).toEqual([
      "2026-03-01",
      "2026-02-28",
      "2026-02-27",
    ])
  })
})
