import { join } from "node:path"

import { Repo } from "./git.ts"
import { releaseGroups } from "./groups.ts"
import { upgradesBetween } from "./upgrades.ts"
import { readJson, writeJson } from "./store.ts"
import { type Npm, repositoryKey } from "./npm.ts"
import { BudgetError, type GitHub } from "./github.ts"
import { isHumanFix, type PrCommit, splitCommits } from "./commits.ts"
import { REFORMAT_SHARE, reformattedLines, share } from "./reformat.ts"
import { bumpOf, isTestFile, type SplitName, splitOf } from "./labels.ts"
import {
  expectedLines,
  type FileDiff,
  meaningful,
  parseDiff,
  SOURCE_FILE,
} from "./diff.ts"
import {
  caseId,
  type CaseLabels,
  type CaseManifest,
  type ExpectedLine,
  saveCase,
  type Upgrade,
} from "./case.ts"

// Renovate names what it updates in the title: "Update dependency zod to v4" for one package,
// "Update sentry-javascript monorepo to v10" for one monorepo release. Those two shapes give cases
// whose expected lines belong to one release. Dependabot is off by default: in a first run, none
// of about a hundred of its merged pull requests carried a commit by a person. `--query` replaces
// the list.
export const RENOVATE_QUERIES = [
  'is:pr is:merged is:public author:app/renovate language:TypeScript "update dependency"',
  'is:pr is:merged is:public author:app/renovate language:JavaScript "update dependency"',
  "is:pr is:merged is:public author:app/renovate language:TypeScript monorepo",
  "is:pr is:merged is:public author:app/renovate language:JavaScript monorepo",
]

export const DEPENDABOT_QUERIES = [
  "is:pr is:merged is:public author:app/dependabot language:TypeScript",
  "is:pr is:merged is:public author:app/dependabot language:JavaScript",
]

// GitHub search ignores punctuation and negated phrases: `"(major)"` matches "non-major", and
// `-"non-major"` removes nothing. The title decides instead, before any clone.
const GROUPED_TITLE =
  /\bnon[- ]?major\b|\ball\b.*\b(?:dependencies|updates)\b|\block ?file maintenance\b/i

export function groupedTitle(title: string): boolean {
  return GROUPED_TITLE.test(title)
}

// GitHub serves 1000 results per search. A merge window holding more is searched as two halves,
// down to an hour.
export const SEARCH_CAP = 1000
const MIN_WINDOW_MS = 3_600_000

export interface Window {
  from: number
  to: number
}

export function windowQuery(w: Window): string {
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z")
  return `merged:${iso(w.from)}..${iso(w.to)}`
}

export function dayWindow(day: string): Window {
  const from = Date.parse(`${day}T00:00:00Z`)
  return { from, to: from + 86_400_000 - 1000 }
}

// The newer half first, like the days.
export function halves(w: Window): Window[] | undefined {
  if (w.to - w.from < 2 * MIN_WINDOW_MS) return undefined
  const mid = w.from + Math.floor((w.to - w.from + 1000) / 2000) * 1000
  return [
    { from: mid, to: w.to },
    { from: w.from, to: mid - 1000 },
  ]
}

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
  searches: Record<
    string,
    { cursor: string | null; done: boolean; split?: boolean }
  >
  prs: Record<
    string,
    { status: "kept" | "rejected"; reason?: string; at: string }
  >
}

export interface MineOptions {
  data: string
  limit: number
  queries: string[]
  // merge dates searched, newest first
  since: string
  until: string
  maxLines: number
  // how many releases one case may upgrade: a release is one package, or the packages of one
  // monorepo published together
  maxPackages: number
  now: Date
  npm: Npm
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

class LimitReached extends Error {}

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
  const keptRepos = new Set(
    Object.entries(state.prs)
      .filter(([, v]) => v.status === "kept")
      .map(([id]) => id.replace(/__\d+$/, ""))
  )
  const reject = (id: string, repo: string, reason: string) => {
    state.prs[id] = { status: "rejected", reason, at: o.now.toISOString() }
    summary.rejected[reason] = (summary.rejected[reason] ?? 0) + 1
    o.log(`  rejected: ${reason}`)
    save()
    // a clone only serves kept cases: without one, it is disk spent for nothing
    if (!keptRepos.has(repo.replace("/", "__"))) new Repo(o.data, repo).remove()
  }

  const consider = async (pr: ApiPr) => {
    if (pr.number === undefined || pr.repository.isPrivate) return
    if (!pr.mergedAt) return
    summary.scanned++
    if (groupedTitle(pr.title)) return
    let commits = toCommits(pr.commits)
    if (!commits.some(isHumanFix) && pr.commits.totalCount <= 10) return
    const repo = pr.repository.nameWithOwner
    const id = caseId(repo, pr.number)
    if (state.prs[id]) return
    if (pr.commits.totalCount > 10) {
      if (pr.commits.totalCount > 100) return
      const [owner, name] = repo.split("/")
      const full = await gh.graphql<{
        repository: { pullRequest: { commits: ApiCommits } }
      }>(COMMITS, { owner, name, number: pr.number })
      commits = toCommits(full.repository.pullRequest.commits)
      if (!commits.some(isHumanFix)) return
    }
    summary.candidates++
    o.log(
      `[${summary.candidates}/${o.limit}] ${pr.url} ${pr.title.slice(0, 70)}`
    )
    const outcome = await mineCandidate(o, pr, commits)
    if (typeof outcome === "string") reject(id, repo, outcome)
    else {
      saveCase(o.data, outcome)
      state.prs[id] = { status: "kept", at: o.now.toISOString() }
      keptRepos.add(repo.replace("/", "__"))
      summary.kept++
      o.log(
        `  kept: ${outcome.packages.length} upgrades, ${outcome.expected.length} expected lines`
      )
      save()
    }
    if (summary.candidates >= o.limit) throw new LimitReached()
  }

  const search = async (query: string, w: Window): Promise<void> => {
    const q = `${query} ${windowQuery(w)}`
    const progress = (state.searches[q] ??= { cursor: null, done: false })
    if (progress.split) {
      for (const h of halves(w)!) await search(query, h)
      return
    }
    while (!progress.done) {
      const page = await gh.graphql<SearchPage>(
        SEARCH,
        { q, cursor: progress.cursor },
        { search: true }
      )
      if (page.search.issueCount > SEARCH_CAP && progress.cursor === null) {
        const parts = halves(w)
        if (parts) {
          progress.split = true
          save()
          for (const h of parts) await search(query, h)
          return
        }
        o.log(
          `${q}: ${page.search.issueCount} results, GitHub serves the first ${SEARCH_CAP} only`
        )
      }
      for (const pr of page.search.nodes) await consider(pr)
      progress.cursor = page.search.pageInfo.endCursor
      progress.done = !page.search.pageInfo.hasNextPage
      save()
    }
  }

  try {
    for (const day of days(o.since, o.until))
      for (const query of o.queries) await search(query, dayWindow(day))
  } catch (e) {
    if (e instanceof BudgetError) summary.stopped = e.message
    else if (!(e instanceof LimitReached)) throw e
  }
  summary.requests = gh.requests
  return summary
}

function round(x: number): number {
  return Math.round(x * 100) / 100
}

// Labels a case carries from the moment it is mined, from the upgrade and the fix alone.
export function mineLabels(
  repo: string,
  pr: number,
  packages: Upgrade[],
  files: FileDiff[],
  expected: ExpectedLine[]
): { split: SplitName; labels: CaseLabels } {
  const layout = reformattedLines(files)
  const removed = files.flatMap((f) =>
    f.oldPath
      ? f.removed
          .filter((l) => meaningful(l.text))
          .map((l) => `${f.oldPath}:${l.line}`)
      : []
  )
  return {
    split: splitOf(repo, pr),
    labels: {
      bump: bumpOf(packages),
      testsOnly: expected.every((e) => isTestFile(e.file)),
      reformatShare: round(
        share(removed.filter((k) => layout.has(k)).length, removed.length)
      ),
      expectedReformatShare: round(
        share(
          expected.filter((e) => layout.has(`${e.file}:${e.line}`)).length,
          expected.length
        )
      ),
    },
  }
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
  if (packages.length > 1) {
    const repositories = new Map<string, string | undefined>()
    for (const p of packages) {
      try {
        const m = await o.npm.manifest(p.name, p.to)
        repositories.set(p.name, repositoryKey(m?.repository))
      } catch {
        repositories.set(p.name, undefined)
      }
    }
    if (releaseGroups(packages, repositories).length > o.maxPackages)
      return "several releases upgraded"
  }

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
  const repoName = pr.repository.nameWithOwner
  const { split: set, labels } = mineLabels(
    repoName,
    pr.number!,
    packages,
    files,
    found.expected
  )
  if (labels.reformatShare >= REFORMAT_SHARE) return "fix is mostly a reformat"
  return {
    id: caseId(repoName, pr.number!),
    source: "bot-pr-human-fix",
    repo: repoName,
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
    split: set,
    labels,
  }
}
