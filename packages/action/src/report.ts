// What the Action decides from a brief, kept apart from the GitHub API so every rule is tested.

export type Verdict = "blocked" | "none" | "quiet" | "review"
export type FailOn = "blocked" | "never" | "review"

export interface BriefLike {
  packages: { verdict: string }[]
}

export interface ExistingComment {
  id: number
  body?: string | null
}

export type CommentPlan =
  { kind: "create" } | { kind: "skip" } | { kind: "update"; id: number }

// the first line of the comment the Action owns; later runs find it and edit it in place
export const MARKER = "<!-- dep-radius -->"

export function verdictOf(brief: BriefLike): Verdict {
  if (brief.packages.length === 0) return "none"
  if (brief.packages.some((p) => p.verdict === "blocked")) return "blocked"
  if (brief.packages.some((p) => p.verdict === "review")) return "review"
  return "quiet"
}

export function parseFailOn(input: string): FailOn {
  const value = input.trim() || "blocked"
  if (value === "blocked" || value === "review" || value === "never")
    return value
  throw new Error(`fail-on must be blocked, review or never, not "${input}"`)
}

export function shouldFail(verdict: Verdict, failOn: FailOn): boolean {
  if (failOn === "never") return false
  if (verdict === "blocked") return true
  return failOn === "review" && verdict === "review"
}

// A pull request that changes no dependency gets no comment, unless one is already there from an
// earlier push: then it is edited, so it never shows a brief that no longer applies.
export function planComment(
  existing: ExistingComment[],
  verdict: Verdict
): CommentPlan {
  const mine = existing.find((c) => c.body?.startsWith(MARKER))
  if (mine) return { kind: "update", id: mine.id }
  return verdict === "none" ? { kind: "skip" } : { kind: "create" }
}

export function commentBody(markdown: string, version: string): string {
  return `${MARKER}\n${markdown.trimEnd()}\n\n<sub>[dep-radius](https://github.com/prakticode/dep-radius) ${version}, updated on every push</sub>\n`
}
