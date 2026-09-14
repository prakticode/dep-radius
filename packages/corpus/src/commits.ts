// How the commits of a bot pull request split into the upgrade and the fix a person pushed on top.

export interface PrCommit {
  sha: string
  parents: string[]
  subject: string
  author: { name: string; email: string; login?: string }
}

export type Split =
  | {
      ok: true
      base: string
      upgraded: string
      fixes: PrCommit[]
      fixEnd: string
    }
  | { ok: false; reason: RejectReason }

export type RejectReason =
  | "no human commit"
  | "first commit is not by a bot"
  | "merge commit before the fix"

// Renovate, Dependabot, and every other app: an autofix or a formatter commit on the branch is not a
// person adapting the code. Self-hosted Renovate commits as "Renovate Bot" from its own address.
const BOT = [
  /\[bot\]/i,
  /^renovate( bot)?$/i,
  /^dependabot$/i,
  /@renovateapp\.com$/i,
  /@dependabot\.com$/i,
  /^bot@/i,
]

export function isBot(author: PrCommit["author"]): boolean {
  return [author.name, author.email, author.login ?? ""].some((s) =>
    BOT.some((re) => re.test(s))
  )
}

export function isMerge(c: PrCommit): boolean {
  return c.parents.length > 1
}

export function isHumanFix(c: PrCommit): boolean {
  return !isMerge(c) && !isBot(c.author)
}

// `commits` in branch order, as GitHub lists them. The upgraded snapshot is the commit just before
// the first human one, whoever wrote it, so its lines are the ones the fix's diff numbers. The fix
// runs up to the last human commit before any merge: a merge brings the base branch's own changes,
// which the fix did not write.
export function splitCommits(commits: PrCommit[]): Split {
  const first = commits.findIndex(isHumanFix)
  if (first < 0) return { ok: false, reason: "no human commit" }
  if (first === 0 || !isBot(commits[0]!.author))
    return { ok: false, reason: "first commit is not by a bot" }
  const before = commits.slice(0, first)
  if (before.some(isMerge))
    return { ok: false, reason: "merge commit before the fix" }
  const stop = commits.findIndex((c, i) => i > first && isMerge(c))
  const run = commits.slice(first, stop < 0 ? commits.length : stop)
  const fixes = run.filter(isHumanFix)
  return {
    ok: true,
    base: commits[0]!.parents[0]!,
    upgraded: commits[first - 1]!.sha,
    fixes,
    fixEnd: fixes.at(-1)!.sha,
  }
}
