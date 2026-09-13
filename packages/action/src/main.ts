import { join } from "node:path"
import { appendFileSync, readFileSync } from "node:fs"

import {
  type BriefLike,
  commentBody,
  type ExistingComment,
  parseFailOn,
  planComment,
  shouldFail,
  verdictOf,
} from "./report.ts"

// Runs after action.yml wrote brief.json and brief.md: sets the outputs, writes the job summary,
// keeps one comment on the pull request up to date, and fails the step when asked to.

const env = process.env
const outDir = required("RADIUS_OUT_DIR")
const jsonPath = join(outDir, "brief.json")
const markdownPath = join(outDir, "brief.md")
const brief = JSON.parse(readFileSync(jsonPath, "utf8")) as BriefLike & {
  exitCode: number
  tool: { version: string }
}
const markdown = readFileSync(markdownPath, "utf8")
const verdict = verdictOf(brief)
const failOn = parseFailOn(env.INPUT_FAIL_ON ?? "")

appendIfSet(
  "GITHUB_OUTPUT",
  `verdict=${verdict}\nexit-code=${brief.exitCode}\njson=${jsonPath}\nmarkdown=${markdownPath}\n`
)
appendIfSet("GITHUB_STEP_SUMMARY", markdown)

if (env.INPUT_COMMENT === "true") {
  const pr = pullRequestNumber()
  if (pr === undefined)
    console.log(
      "::notice title=dep-radius::not a pull request event, so no comment; the brief is in the job summary"
    )
  else
    await upsertComment(pr).catch((error: unknown) => {
      // a read-only token (Dependabot, forks) cannot comment; the summary still has the brief
      console.log(
        `::warning title=dep-radius::could not comment on the pull request: ${String(error)}. Give the job "pull-requests: write", or read the brief in the job summary.`
      )
    })
}

if (shouldFail(verdict, failOn)) {
  console.log(
    `::error title=dep-radius::verdict ${verdict} (fail-on: ${failOn}). The brief says which lines are concerned.`
  )
  process.exitCode = 1
}

async function upsertComment(pr: number): Promise<void> {
  const api = env.GITHUB_API_URL ?? "https://api.github.com"
  const repo = required("GITHUB_REPOSITORY")
  const token = required("INPUT_GITHUB_TOKEN")
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
    })
    if (!res.ok)
      throw new Error(`${init.method ?? "GET"} ${path}: ${res.status}`)
    return res.json()
  }

  const existing: ExistingComment[] = []
  for (let page = 1; ; page++) {
    const batch = (await call(
      `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`
    )) as ExistingComment[]
    existing.push(...batch)
    if (batch.length < 100) break
  }
  const plan = planComment(existing, verdict)
  const body = JSON.stringify({
    body: commentBody(markdown, brief.tool.version),
  })
  if (plan.kind === "update")
    await call(`/repos/${repo}/issues/comments/${plan.id}`, {
      method: "PATCH",
      body,
    })
  else if (plan.kind === "create")
    await call(`/repos/${repo}/issues/${pr}/comments`, { method: "POST", body })
}

function pullRequestNumber(): number | undefined {
  const path = env.GITHUB_EVENT_PATH
  if (!path) return undefined
  const event = JSON.parse(readFileSync(path, "utf8")) as {
    pull_request?: { number?: number }
  }
  return event.pull_request?.number
}

function appendIfSet(name: string, text: string): void {
  const file = env[name]
  if (file) appendFileSync(file, text)
}

function required(name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}
