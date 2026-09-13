import { styleText } from "node:util"

import type { Brief, PackageBrief } from "@dep-radius/core"
import {
  ago,
  coverageLabel,
  groupBriefs,
  oneNetOnly,
  opaqueLabel,
  siteLabel,
  sitesFor,
  surfaceLabel,
} from "@dep-radius/core/render"

export interface TerminalOptions {
  color: boolean
  verbose: boolean
  now: number
}

type Style = Parameters<typeof styleText>[0]

export function renderTerminal(brief: Brief, opts: TerminalOptions): string {
  const c = (style: Style, s: string) => (opts.color ? styleText(style, s) : s)
  const out: string[] = []
  const g = groupBriefs(brief)
  const sources =
    [...new Set(brief.packages.map((p) => p.versionSource))].join(", ") ||
    "none"

  out.push(`${c("bold", "radius")}  ${brief.root}`)
  out.push(
    c(
      "dim",
      `${brief.manifests} ${brief.manifests === 1 ? "manifest" : "manifests"} · ${brief.packages.length} with an update · ${brief.upToDate} up to date · versions from ${sources}`
    )
  )
  out.push("")

  const siteCap = opts.verbose ? Number.POSITIVE_INFINITY : 5
  for (const p of g.detailed) {
    out.push(...packageBlock(p, c, siteCap, opts))
    out.push("")
  }

  if (g.quiet.length > 0) {
    out.push(
      `${c("green", "quiet")} (${g.quiet.length})  ${c("dim", "merge without reading")}`
    )
    const items = g.quiet.map(
      (p) => `${p.pkg} ${p.from} → ${p.to}${oneNetOnly(p) ? "*" : ""}`
    )
    if (opts.verbose)
      for (const p of g.quiet)
        out.push(
          `  ${p.pkg} ${p.from} → ${p.to}  ${c("dim", p.reasons.map((r) => r.detail).join("; "))}`
        )
    else out.push(`  ${items.join(", ")}`)
    if (!opts.verbose && g.quiet.some(oneNetOnly))
      out.push(
        c(
          "dim",
          "  * judged on one net only: no types, or notes missing for some versions (--verbose)"
        )
      )
    out.push("")
  }

  if (g.unseen.length > 0) {
    out.push(
      `${c("yellow", "cannot see how you use these")} (${g.unseen.length})  ${c("dim", "run your build or tests")}`
    )
    for (const p of g.unseen)
      out.push(
        `  ${p.pkg} ${p.from} → ${p.to} ${c("dim", p.bump)}  ${c("dim", opaqueLabel(p))}`
      )
    out.push("")
  }

  if (brief.notAnalyzed.length > 0) {
    out.push(c("dim", `not analysed (${brief.notAnalyzed.length})`))
    for (const n of brief.notAnalyzed)
      out.push(c("dim", `  ${n.pkg}: ${n.reason}`))
    out.push("")
  }

  const globalLine = brief.global.map((x) => `${x.count} ${x.kind}`).join(", ")
  if (globalLine) out.push(c("dim", `whole project: ${globalLine}`))
  if (brief.limits.length > 0) {
    out.push(c("dim", "limits"))
    for (const l of brief.limits) out.push(c("dim", `  - ${l}`))
  }
  const rateLimited = brief.packages.some((p) =>
    p.notes.perVersion.some((v) => v.reason === "rate-limited")
  )
  if (rateLimited) {
    out.push("")
    out.push(
      c(
        "yellow",
        "GitHub's rate limit was reached, so some release notes were not read: set GITHUB_TOKEN or run gh auth login."
      )
    )
  }
  const count = (v: PackageBrief["verdict"]) =>
    brief.packages.filter((p) => p.verdict === v).length
  out.push("")
  out.push(
    `${c("bold", `${brief.packages.length} with an update`)}  ${c("green", `${count("quiet")} quiet`)} · ${c("yellow", `${count("review")} review`)} · ${c("red", `${count("blocked")} blocked`)}  ${c("dim", `· ${brief.upToDate} up to date`)}`
  )
  return `${out.join("\n")}\n`
}

function packageBlock(
  p: PackageBrief,
  c: (style: Style, s: string) => string,
  siteCap: number,
  opts: TerminalOptions
): string[] {
  const lines: string[] = []
  const verdict =
    p.verdict === "blocked"
      ? c(["bold", "red"], "BLOCKED")
      : c(["bold", "yellow"], "REVIEW")
  lines.push(
    `${c("bold", p.pkg)}  ${p.from} → ${p.to}  ${p.bump}  ${c("dim", `published ${ago(p.publishedAt, opts.now)}`)}   ${verdict}`
  )
  const direct = p.notes.matched.filter((m) => m.direct).length
  const possibly = p.notes.matched.length - direct
  lines.push(`  surface changes ......... ${surfaceLabel(p)}`)
  if (p.surface.status === "computed")
    lines.push(`  changes you touch ....... ${p.surface.touched.length}`)
  lines.push(
    `  notes mentioning you .... ${p.notes.coverage === "disabled" ? "not read" : direct}${possibly > 0 ? c("dim", `  (+${possibly} possibly)`) : ""}${c("dim", `  of ${p.notes.total}, ${coverageLabel(p)}`)}`
  )
  lines.push(
    c(
      "dim",
      `  used in ${p.usage.files} ${p.usage.files === 1 ? "file" : "files"}, ${p.usage.sites.length} sites · ${p.manifests.join(", ")}`
    )
  )

  const touchCap = opts.verbose ? Number.POSITIVE_INFINITY : 10
  for (const t of p.surface.touched.slice(0, touchCap)) {
    lines.push("")
    const label = t.bucket === "removed" ? c("red", "removed") : t.bucket
    lines.push(
      `  ${label}  ${c("bold", t.change.path)}${t.strength === "weak" ? c("dim", "  (by member name)") : ""}`
    )
    if (t.change.before)
      lines.push(
        c("dim", `    before  ${t.change.before.join("  |  ").slice(0, 200)}`)
      )
    if (t.change.after)
      lines.push(
        c("dim", `    after   ${t.change.after.join("  |  ").slice(0, 200)}`)
      )
    for (const s of t.sites.slice(0, siteCap)) lines.push(`    ${siteLabel(s)}`)
    if (t.sites.length > siteCap)
      lines.push(c("dim", `    ... ${t.sites.length - siteCap} more`))
  }

  if (p.surface.touched.length > touchCap)
    lines.push(
      "",
      c(
        "dim",
        `  ... ${p.surface.touched.length - touchCap} more changes you touch (--verbose)`
      )
    )

  const shownNotes = opts.verbose
    ? p.notes.matched
    : p.notes.matched.slice(0, 8)
  if (shownNotes.length > 0) lines.push("")
  for (const m of shownNotes) {
    const names = [...new Set(m.hits.map((h) => h.name))]
    const tag = m.direct ? "" : c("dim", "  possibly")
    lines.push(`  ${c("cyan", m.entry.version)}  ${m.entry.title}${tag}`)
    const strongNames = m.hits
      .filter((h) => h.strength === "strong")
      .map((h) => h.name)
    const sites = sitesFor(p, strongNames.length > 0 ? strongNames : names)
    lines.push(c("dim", `    you use: ${names.join(", ")}`))
    for (const s of sites.slice(0, m.direct ? Math.min(3, siteCap) : 1))
      lines.push(`    ${siteLabel(s)}`)
    if (sites.length > (m.direct ? Math.min(3, siteCap) : 1))
      lines.push(
        c(
          "dim",
          `    ... ${sites.length - (m.direct ? Math.min(3, siteCap) : 1)} more sites`
        )
      )
  }
  if (p.notes.matched.length > shownNotes.length)
    lines.push(
      c(
        "dim",
        `  ... ${p.notes.matched.length - shownNotes.length} more notes (--verbose)`
      )
    )
  for (const e of p.notes.unattributedBreaking)
    lines.push(
      `  ${c("cyan", e.version)}  ${e.title}  ${c("dim", "breaking, names no API")}`
    )

  lines.push("")
  for (const r of p.reasons) lines.push(c("dim", `  why: ${r.detail}`))
  const skipped = p.skippedNewer.filter((s) => s.reason === "too-new")
  if (skipped.length > 0) {
    lines.push(
      c(
        "dim",
        `  newer, held back: ${skipped.map((s) => `${s.version} (${s.publishedAt ? ago(s.publishedAt, opts.now) : "too new"})`).join(", ")}`
      )
    )
  }
  if (p.alsoAvailable)
    lines.push(
      c(
        "dim",
        `  also available: ${p.alsoAvailable.version} (${p.alsoAvailable.bump}, not analysed; radius ${p.pkg}@${p.alsoAvailable.version})`
      )
    )
  return lines
}
