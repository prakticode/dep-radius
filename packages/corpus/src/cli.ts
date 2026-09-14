#!/usr/bin/env node
import { resolve } from "node:path"
import { execFile } from "node:child_process"
import { parseArgs, promisify } from "node:util"

import { defaultCacheDir } from "@dep-radius/core"

import { Npm } from "./npm.ts"
import { check } from "./check.ts"
import { defaultDataDir } from "./store.ts"
import { BudgetError, GitHub } from "./github.ts"
import { evaluate, renderSummary } from "./evaluate.ts"
import { DEPENDABOT_QUERIES, mine, RENOVATE_QUERIES } from "./mine.ts"

const HELP = `corpus: real upgrade cases from GitHub, and radius measured on them

usage
  corpus mine [--limit 40] [--since 2026-06-01] [--until 2026-09-13] [--query <q>]... [--dependabot]
              [--max-lines 300] [--max-packages 1]
  corpus check [--limit 1000]
  corpus evaluate [--limit 1000] [--concurrency 2] [--force] [--all]

options
  --data <dir>    where cases, clones and reports go (default $XDG_CACHE_HOME/dep-radius-corpus,
                  or ~/.cache/dep-radius-corpus)
  --keep <n>      stop when the GitHub budget the command spends falls under n (default 500)

GITHUB_TOKEN, GH_TOKEN or a logged in gh supply the token.
`

const exec = promisify(execFile)

async function token(): Promise<string> {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (t) return t
  try {
    const { stdout } = await exec("gh", ["auth", "token"], { timeout: 5000 })
    if (stdout.trim()) return stdout.trim()
  } catch {
    // reported below
  }
  throw new Error("no GitHub token: set GITHUB_TOKEN or log in with gh")
}

const log = (line: string) => process.stderr.write(`${line}\n`)

function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

async function main(argv: string[]): Promise<number> {
  // a repository that went private or away must fail its fetch, not wait for a password
  process.env.GIT_TERMINAL_PROMPT = "0"
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      keep: { type: "string", default: "500" },
      limit: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      query: { type: "string", multiple: true },
      "max-lines": { type: "string", default: "300" },
      "max-packages": { type: "string", default: "1" },
      dependabot: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      concurrency: { type: "string", default: "2" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  const cmd = positionals[0]
  if (values.help || !cmd) {
    process.stdout.write(HELP)
    return cmd || values.help ? 0 : 3
  }
  const data = resolve(values.data ?? defaultDataDir(process.env))
  const keep = Number(values.keep)
  const now = Date.now()

  if (cmd === "check") {
    const reviews = await check({
      data,
      limit: Number(values.limit ?? "1000"),
      npm: new Npm(data),
      log,
    })
    const count: Record<string, number> = {}
    for (const r of reviews) count[r.result] = (count[r.result] ?? 0) + 1
    process.stdout.write(
      `${reviews.length} cases checked: ${Object.entries(count)
        .map(([k, n]) => `${n} ${k}`)
        .join(
          ", "
        )}; ${reviews.filter((r) => r.testsOnly).length} fix tests only\nreview: ${resolve(data, "review.md")}\n`
    )
    return 0
  }

  const gh = new GitHub({
    token: await token(),
    cacheDir: resolve(data, "api"),
    keep,
    log,
  })
  const budget = async () => ({
    core: (await gh.probe("core")).remaining,
    graphql: (await gh.probe("graphql")).remaining,
  })
  const before = await budget()
  log(
    `data ${data}; GitHub budget: core ${before.core}, graphql ${before.graphql}`
  )

  if (cmd === "mine") {
    const s = await mine(gh, {
      data,
      limit: Number(values.limit ?? "40"),
      queries: values.query?.length
        ? values.query
        : [
            ...RENOVATE_QUERIES,
            ...(values.dependabot ? DEPENDABOT_QUERIES : []),
          ],
      since: values.since ?? isoDay(now - 90 * 86_400_000),
      // yesterday at the latest: a day still going returns different results on the next run
      until: values.until ?? isoDay(now - 86_400_000),
      maxLines: Number(values["max-lines"]),
      maxPackages: Number(values["max-packages"]),
      npm: new Npm(data),
      now: new Date(now),
      log,
    })
    const after = await budget()
    process.stdout.write(
      `${JSON.stringify(
        {
          ...s,
          // shared with every other client of the token, so an estimate
          budgetBefore: before,
          budgetAfter: after,
        },
        null,
        2
      )}\n`
    )
    if (s.stopped) log(s.stopped)
    return 0
  }

  if (cmd === "evaluate") {
    const s = await evaluate(gh, {
      data,
      limit: Number(values.limit ?? "1000"),
      concurrency: Number(values.concurrency),
      force: values.force,
      all: values.all,
      radiusCache: defaultCacheDir(process.env),
      log,
    })
    const after = await budget()
    process.stdout.write(`${renderSummary(s)}\n`)
    process.stdout.write(
      `evaluated ${s.evaluated}, skipped ${s.skipped} already evaluated; core budget ${before.core} -> ${after.core} (shared with other clients of the token)\nreport: ${resolve(data, "report.json")}\n`
    )
    if (s.stopped) log(s.stopped)
    return 0
  }

  process.stdout.write(HELP)
  return 3
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    log(
      e instanceof BudgetError
        ? e.message
        : e instanceof Error
          ? (e.stack ?? e.message)
          : String(e)
    )
    process.exitCode = 3
  }
)
