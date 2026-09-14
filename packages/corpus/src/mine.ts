import { join } from "node:path"

import { Repo } from "./git.ts"
import { upgradesBetween } from "./upgrades.ts"
import { readJson, writeJson } from "./store.ts"
import { BudgetError, type GitHub } from "./github.ts"
import { expectedLines, parseDiff, SOURCE_FILE } from "./diff.ts"
import { isHumanFix, type PrCommit, splitCommits } from "./commits.ts"
import { caseId, type CaseManifest, saveCase, type Upgrade } from "./case.ts"

// Renovate names the update kind in its titles and bodies, and a major is the update most likely
// to need a fix: the richest source per search request. Dependabot never does, so it is searched
// whole. `--query` replaces the list.
export const DEFAULT_QUERIES = [
  'is:pr is:merged is:public author:app/renovate language:TypeScript "(major)"',
  'is:pr is:merged is:public author:app/renovate language:JavaScript "(major)"',
  "is:pr is:merged is:public author:app/dependabot language:TypeScript",
  "is:pr is:merged is:public author:app/dependabot language:JavaScript",
]

const SEARCH = `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    issueCount
    pageInfo { endCursor hasNextPage }
    nodes {
      ... on PullRequest {
        number title url mergedAt
        author { login }
        repository { nameWithOwner isPrivate }
        commits(first: 10) {
          totalCount
          nodes { commit { ...C } }
        }
      }
    }
  }
}
fragment C on Commit {
  oid messageHeadline
  parents(first: 3) { nodes { oid } }
  author { name email user { login } }
}`

const COMMITS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100) {
        totalCount
        nodes { commit { ...C } }
      }
    }
  }
}
fragment C on Commit {
  oid messageHeadline
  parents(first: 3) { nodes { oid } }
  author { name email user { login } }
}`

interface ApiCommit {
  oid: string
  messageHeadline: string
  parents: { nodes: { oid: string }[] }
  author: { name: string; email: string; user: { login: string } | null }
}

interface ApiCommits {
  totalCount: number
  nodes: { commit: ApiCommit }[]
}

interface ApiPr {
  number?: number
  title: string
  url: string
  mergedAt: string | null
  author: { login: string } | null
  repository: { nameWithOwner: string; isPrivate: boolean }
  commits: ApiCommits
}

interface SearchPage {
  search: {
    issueCount: number
    pageInfo: { endCursor: string | null; hasNextPage: boolean }
    nodes: ApiPr[]
  }
}

export interface MineState {
  searches: Record<string, { cursor: string | null; done: boolean }>
  prs: Record<
    string,
    { status: "kept" | "rejected"; reason?: string; at: string }
  >
}

export interface MineOptions {
  data: string
  limit: number
  queries: string[]
  // merge dates searched, newest first, one day per search so no day passes GitHub's 1000 results
  since: string
  until: string
  maxLines: number
  now: Date
  log: (line: string) => void
}

export function toCommits(api: ApiCommits): PrCommit[] {
  return api.nodes.map(({ commit: c }) => ({
    sha: c.oid,
    parents: c.parents.nodes.map((p) => p.oid),
    subject: c.messageHeadline,
    author: {
      name: c.author.name,
      email: c.author.email,
      ...(c.author.user ? { login: c.author.user.login } : {}),
    },
  }))
}

export function days(since: string, until: string): string[] {
  const out: string[] = []
  const stop = Date.parse(`${since}T00:00:00Z`)
  for (let t = Date.parse(`${until}T00:00:00Z`); t >= stop; t -= 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

export interface MineSummary {
  scanned: number
  candidates: number
  kept: number
  rejected: Record<string, number>
  stopped?: string
  requests: number
}

export async function mine(gh: GitHub, o: MineOptions): Promise<MineSummary> {
  const statePath = join(o.data, "state", "mine.json")
  const state = readJson<MineState>(statePath) ?? { searches: {}, prs: {} }
  const save = () => writeJson(statePath, state)
  const summary: MineSummary = {
    scanned: 0,
    candidates: 0,
    kept: 0,
    rejected: {},
    requests: 0,
  }
  const reject = (id: string, reason: string) => {
    state.prs[id] = { status: "rejected", reason, at: o.now.toISOString() }
    summary.rejected[reason] = (summary.rejected[reason] ?? 0) + 1
    o.log(`  rejected: ${reason}`)
    save()
  }

  try {
    outer: for (const query of o.queries) {
      for (const day of days(o.since, o.until)) {
        const q = `${query} merged:${day}`
        const progress = (state.searches[q] ??= { cursor: null, done: false })
        while (!progress.done) {
          const page = await gh.graphql<SearchPage>(
            SEARCH,
            { q, cursor: progress.cursor },
            { search: true }
          )
          if (page.search.issueCount > 1000 && progress.cursor === null)
            o.log(
              `${q}: ${page.search.issueCount} results, GitHub serves the first 1000 only`
            )
          for (const pr of page.search.nodes) {
            if (pr.number === undefined || pr.repository.isPrivate) continue
            if (!pr.mergedAt) continue
            summary.scanned++
            let commits = toCommits(pr.commits)
            if (!commits.some(isHumanFix) && pr.commits.totalCount <= 10)
              continue
            const id = caseId(pr.repository.nameWithOwner, pr.number)
            if (state.prs[id]) continue
            if (pr.commits.totalCount > 10) {
              if (pr.commits.totalCount > 100) continue
              const [owner, name] = pr.repository.nameWithOwner.split("/")
              const full = await gh.graphql<{
                repository: { pullRequest: { commits: ApiCommits } }
              }>(COMMITS, { owner, name, number: pr.number })
              commits = toCommits(full.repository.pullRequest.commits)
              if (!commits.some(isHumanFix)) continue
            }
            summary.candidates++
            o.log(
              `[${summary.candidates}/${o.limit}] ${pr.url} ${pr.title.slice(0, 70)}`
            )
            const outcome = await mineCandidate(o, pr, commits)
            if (typeof outcome === "string") reject(id, outcome)
            else {
              saveCase(o.data, outcome)
              state.prs[id] = { status: "kept", at: o.now.toISOString() }
              summary.kept++
              o.log(
                `  kept: ${outcome.packages.length} upgrades, ${outcome.expected.length} expected lines`
              )
              save()
            }
            if (summary.candidates >= o.limit) break outer
          }
          progress.cursor = page.search.pageInfo.endCursor
          progress.done = !page.search.pageInfo.hasNextPage
          save()
        }
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e
    summary.stopped = e.message
  }
  summary.requests = gh.requests
  return summary
}

async function mineCandidate(
  o: MineOptions,
  pr: ApiPr,
  commits: PrCommit[]
): Promise<CaseManifest | string> {
  const split = splitCommits(commits)
  if (!split.ok) return split.reason
  const repo = new Repo(o.data, pr.repository.nameWithOwner)
  try {
    await repo.fetchCommits([split.base, split.upgraded, split.fixEnd])
  } catch {
    return "git fetch failed"
  }
  let packages: Upgrade[]
  try {
    packages = await upgradesBetween(repo, split.base, split.upgraded)
  } catch (e) {
    o.log(`  ${String(e).slice(0, 200)}`)
    return "could not read the lockfiles"
  }
  if (packages.length === 0) return "no dependency upgraded"

  const paths = (await repo.changedPaths(split.upgraded, split.fixEnd)).filter(
    (p) => SOURCE_FILE.test(p) && !p.split("/").includes("node_modules")
  )
  const wanted = new Set(paths)
  await repo.prefetch(split.upgraded, (p) => wanted.has(p))
  await repo.prefetch(split.fixEnd, (p) => wanted.has(p))
  const files = parseDiff(await repo.diff(split.upgraded, split.fixEnd, paths))
  const texts = new Map<string, string>()
  for (const f of files)
    if (f.oldPath && f.removed.length > 0) {
      const text = await repo.show(split.upgraded, f.oldPath)
      if (text !== undefined) texts.set(f.oldPath, text)
    }
  const found = expectedLines(
    files,
    packages.map((p) => p.name),
    (p) => texts.get(p)
  )
  if (found.empty) return found.empty
  // a fix rewriting hundreds of lines is a refactor or a reformat riding along, not an adaptation
  if (found.expected.length > o.maxLines) return "fix too large"
  return {
    id: caseId(pr.repository.nameWithOwner, pr.number!),
    source: "bot-pr-human-fix",
    repo: pr.repository.nameWithOwner,
    pr: pr.number!,
    url: pr.url,
    title: pr.title,
    bot: pr.author?.login ?? "",
    mergedAt: pr.mergedAt ?? "",
    base: split.base,
    upgraded: split.upgraded,
    fixes: split.fixes.map((c) => ({
      sha: c.sha,
      author: c.author.login ?? c.author.name,
      subject: c.subject,
    })),
    fixEnd: split.fixEnd,
    packages,
    expected: found.expected,
    added: found.added,
    minedAt: o.now.toISOString(),
  }
}
