import { join } from "node:path"
import { existsSync, readdirSync, readFileSync } from "node:fs"

import { writeJson } from "./store.ts"
import type { Bump, SplitName } from "./labels.ts"

export interface Upgrade {
  name: string
  from: string
  to: string
}

// A line of the upgraded snapshot the fix removed or rewrote, in a file importing an upgraded package
export interface ExpectedLine {
  file: string
  line: number
  text: string
  // the upgraded packages the file imports: the line counts for those packages only
  imports: string[]
}

export interface FixCommit {
  sha: string
  author: string
  subject: string
}

// One mined case. Every line number is in the `upgraded` snapshot, the tree radius reads.
export interface CaseManifest {
  id: string
  source: "bot-pr-human-fix"
  repo: string
  pr: number
  url: string
  title: string
  bot: string
  mergedAt: string
  // the commit the bot branched from: `radius --since` compares with it
  base: string
  // the last bot commit before the first human one: upgraded, not yet fixed
  upgraded: string
  fixes: FixCommit[]
  // the last human commit: the fix is the diff from `upgraded` to it
  fixEnd: string
  packages: Upgrade[]
  expected: ExpectedLine[]
  // the lines the fix wrote in the same files, for `check`
  added: { file: string; line: number; text: string }[]
  minedAt: string
  // `working` cases are read while improving radius; `locked` ones only ever give totals
  split: SplitName
  labels: CaseLabels
}

export type TypesSource = "bundled" | "@types" | "none" | "unknown"

export type CheckResult = "supported" | "weak" | "reformat" | "error"

export interface CaseLabels {
  // the largest step among the upgrades
  bump: Bump
  // every expected line is in a test file: the upgrade broke tests, not the product
  testsOnly: boolean
  // share of the fix's removed source lines that only changed layout, and of the expected lines
  reformatShare: number
  expectedReformatShare: number
  // where each upgraded package's types come from, filled by `check`
  types?: Record<string, TypesSource>
  // filled by `check`
  check?: CheckResult
}

export function caseId(repo: string, pr: number): string {
  return `${repo.replace("/", "__")}__${pr}`
}

export function casesDir(data: string): string {
  return join(data, "cases")
}

export function saveCase(data: string, c: CaseManifest): void {
  writeJson(join(casesDir(data), `${c.id}.json`), c)
}

export function loadCases(data: string): CaseManifest[] {
  const dir = casesDir(data)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as CaseManifest)
}
