import { promisify } from "node:util"
import { execFile } from "node:child_process"

import { DiskCache } from "./infra/cache.ts"
import { createLogger } from "./infra/log.ts"
import { createLimiter } from "./infra/limit.ts"
import type { Ctx, Options } from "./options.ts"
import { FetchHttp, type HttpClient, NoNetworkHttp } from "./infra/http.ts"

const run = promisify(execFile)

export function createCtx(opts: Options, http?: HttpClient): Ctx {
  let token: Promise<string | undefined> | undefined
  return {
    http: http ?? (opts.offline ? new NoNetworkHttp() : new FetchHttp()),
    cache: new DiskCache(opts.cacheDir),
    now: opts.now,
    offline: opts.offline,
    log: createLogger(opts.verbose),
    net: createLimiter(opts.concurrency),
    github: createLimiter(Math.min(4, opts.concurrency)),
    heavy: createLimiter(2),
    githubToken: () => (token ??= findGithubToken()),
    env: process.env,
  }
}

// Sent to api.github.com only.
async function findGithubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 2000 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}
