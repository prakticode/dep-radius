#!/usr/bin/env node
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { createRequire } from "node:module"
import { existsSync, statSync } from "node:fs"

import { runDebug } from "@dep-radius/core/debug"
import {
  createCtx,
  defaultCacheDir,
  type Format,
  type Options,
  parseDuration,
  renderJson,
  renderMarkdown,
  run,
} from "@dep-radius/core"

import { renderTerminal } from "./render/terminal.ts"
import { createProgressView } from "./render/progress.ts"

const HELP = `radius: which changes in a dependency update land on code you wrote

usage
  radius [path]                      every direct dependency with an update waiting
  radius <pkg>[@<version|tag>] ...   only these packages (a version analyses that exact target)
  radius --since <git-ref>           the dependencies whose version changed since that commit,
                                     for a pull request or right after an upgrade

options
  --json                 the brief as JSON (schemaVersion 1)
  --markdown             a pull request comment
  --offline              read the cache only, never the network
  --min-age <duration>   hold back versions younger than this (default 1d, or the project's
                         minimumReleaseAge); "0" disables
  --latest               target the newest version, across majors
  --no-notes             do not read release notes
  --no-surface           do not compare type surfaces
  --prod                 skip devDependencies
  --concurrency <n>      network requests at once (default 8)
  --cache-dir <dir>      default $RADIUS_CACHE_DIR, then the platform cache folder
  --verbose              every note, every site, every quiet package
  --version, --help

exit codes
  0 quiet: nothing you use changed    1 review: read the brief    2 blocked: something you use was removed
  3 the command itself failed

GITHUB_TOKEN, GH_TOKEN or a logged in gh raise the GitHub limit from 60 to 5000 requests an hour.
`

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "debug") return runDebug(argv.slice(1))
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        json: { type: "boolean" },
        markdown: { type: "boolean" },
        offline: { type: "boolean" },
        "min-age": { type: "string" },
        latest: { type: "boolean" },
        since: { type: "string" },
        notes: { type: "boolean", default: true },
        surface: { type: "boolean", default: true },
        prod: { type: "boolean" },
        concurrency: { type: "string" },
        "cache-dir": { type: "string" },
        verbose: { type: "boolean", short: "v" },
        now: { type: "string" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    process.stderr.write(`radius: ${(error as Error).message}\n\n${HELP}`)
    return 3
  }
  const v = parsed.values
  if (v.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (v.version) {
    process.stdout.write(`${cliVersion()}\n`)
    return 0
  }
  if (v.json && v.markdown) {
    process.stderr.write("radius: --json and --markdown cannot be combined\n")
    return 3
  }
  if (v.since !== undefined && v.latest) {
    process.stderr.write("radius: --since and --latest cannot be combined\n")
    return 3
  }

  let root = process.cwd()
  const specs: string[] = []
  // a path is written like one (./x, ../x, /x, a/b that exists); a bare word is a package, so a
  // folder that shares a package's name is reached as ./name
  for (const p of parsed.positionals) {
    const abs = resolve(p)
    const pathLike =
      p === "." ||
      p.startsWith("./") ||
      p.startsWith("../") ||
      p.startsWith("/") ||
      p.includes("\\") ||
      (p.includes("/") && !p.startsWith("@"))
    if (pathLike && existsSync(abs) && statSync(abs).isDirectory()) root = abs
    else if (pathLike) {
      process.stderr.write(`radius: ${p} is not a directory\n`)
      return 3
    } else specs.push(p)
  }
  if (!existsSync(root)) {
    process.stderr.write(`radius: ${root} does not exist\n`)
    return 3
  }

  const nowRaw = v.now ?? process.env.RADIUS_NOW
  const now = nowRaw ? Date.parse(nowRaw) : Date.now()
  if (!Number.isFinite(now)) {
    process.stderr.write(`radius: invalid --now ${nowRaw}\n`)
    return 3
  }
  let minAgeMs: number | undefined
  try {
    minAgeMs =
      v["min-age"] !== undefined ? parseDuration(v["min-age"]) : undefined
  } catch (error) {
    process.stderr.write(`radius: ${(error as Error).message}\n`)
    return 3
  }
  const format: Format = v.json ? "json" : v.markdown ? "markdown" : "terminal"
  const opts: Options = {
    root,
    specs,
    format,
    offline: !!v.offline,
    minAgeMs,
    latest: !!v.latest,
    ...(v.since ? { since: v.since } : {}),
    notes: v.notes !== false,
    surface: v.surface !== false,
    prod: !!v.prod,
    concurrency: Math.max(1, Number(v.concurrency ?? 8) || 8),
    cacheDir: v["cache-dir"]
      ? resolve(v["cache-dir"])
      : defaultCacheDir(process.env),
    verbose: !!v.verbose,
    now,
    color:
      format === "terminal" && !!process.stdout.isTTY && !process.env.NO_COLOR,
  }
  const ctx = createCtx(opts)
  // a person watching gets progress on stderr; --json, --markdown, CI and pipes get none
  const view =
    format === "terminal" &&
    process.stderr.isTTY &&
    // a pseudo terminal that reports no width wraps every frame after one character
    (process.stderr.columns ?? 0) >= 40 &&
    !process.env.CI
      ? createProgressView(process.stderr)
      : undefined
  let brief
  try {
    brief = await run(opts, ctx, view ? (e) => view.onEvent(e) : undefined)
  } catch (error) {
    view?.fail()
    throw error
  }
  view?.finish(brief)
  const text =
    format === "json"
      ? renderJson(brief)
      : format === "markdown"
        ? renderMarkdown(brief, now)
        : renderTerminal(brief, {
            color: opts.color,
            verbose: opts.verbose,
            now,
          })
  process.stdout.write(text)
  return brief.exitCode
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `radius: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
    process.exitCode = 3
  }
)

// the version of this package, which is what `radius --version` reports; the brief carries the engine's
function cliVersion(): string {
  return (
    createRequire(import.meta.url)("../package.json") as { version: string }
  ).version
}
