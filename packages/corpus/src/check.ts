import { join } from "node:path"
import { writeFileSync } from "node:fs"

import {
  buildInventory,
  listProjectFiles,
  scanUsage,
} from "@dep-radius/core/debug"

import { writeJson } from "./store.ts"
import { prepareSnapshot } from "./evaluate.ts"
import { type CaseManifest, loadCases } from "./case.ts"

export interface PackageUsageFacts {
  // every name the scan saw the code use from the package
  names: string[]
  // every place it did
  sites: { file: string; line: number }[]
}

export interface Evidence {
  package: string
  // expected lines that are themselves a use of the package
  onSite: string[]
  // names used from the package that the fix's removed or written lines mention
  names: string[]
}

export interface Review {
  id: string
  url: string
  title: string
  packages: string[]
  expected: number
  // nothing ties the fix to what the code uses from the upgraded packages: a person decides
  weak: boolean
  evidence: Evidence[]
  error?: string
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A case is weak when no changed line is a use of an upgraded package and none mentions a name the
// code uses from one. Such a fix may still answer the upgrade (a changed return value handled
// further down), or be unrelated work pushed on the same branch: only reading tells.
export function judge(
  c: Pick<CaseManifest, "expected" | "added" | "packages">,
  usage: Record<string, PackageUsageFacts>
): { weak: boolean; evidence: Evidence[] } {
  const evidence: Evidence[] = []
  for (const p of c.packages) {
    const facts = usage[p.name]
    const removed = c.expected.filter((e) => e.imports.includes(p.name))
    if (!facts || removed.length === 0) continue
    const files = new Set(removed.map((e) => e.file))
    const sites = new Set(facts.sites.map((s) => `${s.file}:${s.line}`))
    const onSite = removed
      .map((e) => `${e.file}:${e.line}`)
      .filter((k) => sites.has(k))
    const texts = [
      ...removed.map((e) => e.text),
      ...c.added.filter((a) => files.has(a.file)).map((a) => a.text),
    ]
    const names = facts.names.filter((n) => {
      const re = new RegExp(`(?<![\\w$])${escape(n)}(?![\\w$])`)
      return texts.some((t) => re.test(t))
    })
    if (onSite.length > 0 || names.length > 0)
      evidence.push({ package: p.name, onSite, names })
  }
  return { weak: evidence.length === 0, evidence }
}

export interface CheckOptions {
  data: string
  limit: number
  log: (line: string) => void
}

async function usageOf(
  data: string,
  c: CaseManifest
): Promise<Record<string, PackageUsageFacts>> {
  const root = await prepareSnapshot(data, c)
  const files = await listProjectFiles(root)
  const inventory = await buildInventory(root, { prod: false }, files)
  const scan = await scanUsage(undefined, root, files, inventory)
  const out: Record<string, PackageUsageFacts> = {}
  for (const u of Object.values(scan.packages)) {
    if (!c.packages.some((p) => p.name === u.pkg)) continue
    const prev = out[u.pkg] ?? { names: [], sites: [] }
    out[u.pkg] = {
      names: [...new Set([...prev.names, ...u.strongNames, ...u.weakNames])],
      sites: [...prev.sites, ...u.refs.map((r) => r.site)],
    }
  }
  return out
}

export async function check(o: CheckOptions): Promise<Review[]> {
  const reviews: Review[] = []
  for (const c of loadCases(o.data).slice(0, o.limit)) {
    const base = {
      id: c.id,
      url: c.url,
      title: c.title,
      packages: c.packages.map((p) => `${p.name} ${p.from} -> ${p.to}`),
      expected: c.expected.length,
    }
    try {
      const verdict = judge(c, await usageOf(o.data, c))
      reviews.push({ ...base, ...verdict })
      o.log(`${c.id}: ${verdict.weak ? "weak" : "supported"}`)
    } catch (e) {
      reviews.push({
        ...base,
        weak: true,
        evidence: [],
        error: String(e).slice(0, 300),
      })
      o.log(`${c.id}: error ${String(e).slice(0, 200)}`)
    }
  }
  writeJson(join(o.data, "review.json"), reviews)
  writeFileSync(
    join(o.data, "review.md"),
    renderReview(reviews, loadCases(o.data))
  )
  return reviews
}

// The weak cases, each with what a reviewer needs to decide without opening anything else first.
export function renderReview(reviews: Review[], cases: CaseManifest[]): string {
  const weak = reviews.filter((r) => r.weak)
  const out = [
    "# Cases to review",
    "",
    `${weak.length} of ${reviews.length} cases are weak: no changed line uses an upgraded package, and none mentions a name the code uses from one.`,
    "Keep a case when the fix answers the upgrade; delete its manifest from `cases/` otherwise.",
    "",
  ]
  for (const r of weak) {
    const c = cases.find((x) => x.id === r.id)
    out.push(`## ${r.id}`, "", `${r.title}`, "", r.url, "")
    for (const p of r.packages) out.push(`- ${p}`)
    if (r.error) out.push("", `error: ${r.error}`)
    if (c) {
      out.push("", "```")
      for (const e of c.expected.slice(0, 15))
        out.push(`${e.file}:${e.line}  ${e.text.trim().slice(0, 100)}`)
      if (c.expected.length > 15) out.push(`... ${c.expected.length - 15} more`)
      out.push("```")
    }
    out.push("")
  }
  return out.join("\n")
}
