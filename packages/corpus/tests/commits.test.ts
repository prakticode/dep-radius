import { describe, expect, it } from "vitest"

import {
  isBot,
  isHumanFix,
  type PrCommit,
  splitCommits,
} from "../src/commits.ts"

const renovate = {
  name: "renovate[bot]",
  email: "29139614+renovate[bot]@users.noreply.github.com",
  login: "renovate[bot]",
}
const dependabot = {
  name: "dependabot[bot]",
  email: "49699333+dependabot[bot]@users.noreply.github.com",
}
const actions = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
}
const human = { name: "Ada", email: "ada@example.com", login: "ada" }

let n = 0
function commit(
  author: PrCommit["author"],
  parents = 1,
  sha = `c${++n}`
): PrCommit {
  return {
    sha,
    parents: Array.from({ length: parents }, (_, i) => `${sha}-p${i}`),
    subject: sha,
    author,
  }
}

describe("isBot", () => {
  it("recognises Renovate, Dependabot and other GitHub apps", () => {
    expect(isBot(renovate)).toBe(true)
    expect(isBot(dependabot)).toBe(true)
    expect(isBot(actions)).toBe(true)
  })

  it("recognises self-hosted Renovate by its name and address", () => {
    expect(isBot({ name: "Renovate Bot", email: "bot@renovateapp.com" })).toBe(
      true
    )
  })

  it("treats a person as a person", () => {
    expect(isBot(human)).toBe(false)
  })

  it("does not count a merge commit by a person as a fix", () => {
    expect(isHumanFix(commit(human, 2))).toBe(false)
    expect(isHumanFix(commit(human))).toBe(true)
  })
})

describe("splitCommits", () => {
  it("takes the commit before the first human one as the upgraded snapshot", () => {
    const bot = commit(renovate)
    const lock = commit(actions)
    const fix = commit(human)
    const split = splitCommits([bot, lock, fix])
    expect(split).toMatchObject({
      ok: true,
      base: bot.parents[0],
      upgraded: lock.sha,
      fixEnd: fix.sha,
    })
  })

  it("keeps every human commit up to the first merge, and ends the fix at the last one", () => {
    const bot = commit(dependabot)
    const fix1 = commit(human)
    const rebump = commit(dependabot)
    const fix2 = commit(human)
    const merge = commit(human, 2)
    const later = commit(human)
    const split = splitCommits([bot, fix1, rebump, fix2, merge, later])
    expect(split.ok && split.fixes.map((c) => c.sha)).toEqual([
      fix1.sha,
      fix2.sha,
    ])
    expect(split.ok && split.fixEnd).toBe(fix2.sha)
  })

  it("ignores trailing bot commits after the last human fix", () => {
    const bot = commit(renovate)
    const fix = commit(human)
    const artifacts = commit(renovate)
    const split = splitCommits([bot, fix, artifacts])
    expect(split.ok && split.fixEnd).toBe(fix.sha)
  })

  it("rejects a pull request no person committed to", () => {
    expect(splitCommits([commit(renovate), commit(actions)])).toEqual({
      ok: false,
      reason: "no human commit",
    })
  })

  it("rejects a pull request a person started", () => {
    expect(splitCommits([commit(human), commit(renovate)])).toEqual({
      ok: false,
      reason: "first commit is not by a bot",
    })
  })

  it("rejects a branch that merged its base before the fix", () => {
    expect(
      splitCommits([commit(renovate), commit(human, 2), commit(human)])
    ).toEqual({ ok: false, reason: "merge commit before the fix" })
  })
})
