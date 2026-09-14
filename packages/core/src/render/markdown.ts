import type { Brief, PackageBrief, UnplacedEntry } from "../model.ts"
import {
  ago,
  coverageLabel,
  groupBriefs,
  likelyLabel,
  oneNetOnly,
  opaqueLabel,
  orderFindings,
  sinceLabel,
  siteLabel,
  sitesFor,
  surfaceLabel,
  usedLabel,
} from "./groups.ts"

// A pull request comment: one table, then a section per package that needs a look.
export function renderMarkdown(brief: Brief, now: number): string {
  const g = groupBriefs(brief)
  const out: string[] = []
  const icon = { blocked: "🛑 blocked", review: "👀 review", quiet: "✅ quiet" }
  out.push("### radius")
  out.push("")
  if (brief.since)
    out.push(`Dependency changes since ${sinceLabel(brief.since)}.`, "")
  if (brief.packages.length === 0) {
    out.push(
      brief.since
        ? "No direct dependency changed version."
        : "No dependency has an eligible update."
    )
    return `${out.join("\n")}\n`
  }
  out.push(
    "| package | update | verdict | surface changes | changes you touch | notes mentioning you |"
  )
  out.push("| --- | --- | --- | --- | --- | --- |")
  for (const p of [...g.detailed, ...g.unseen, ...g.quiet]) {
    const direct = p.notes.matched.filter((m) => m.direct).length
    const possibly = p.notes.matched.length - direct
    out.push(
      `| \`${p.pkg}\` | ${p.from} → ${p.to} (${p.bump}) | ${icon[p.verdict]}${oneNetOnly(p) ? " (one net)" : ""} | ${surfaceLabel(p)} | ${p.surface.status === "computed" ? p.surface.touched.length : "n/a"} | ${p.notes.coverage === "disabled" ? "not read" : `${direct}${possibly ? ` (+${possibly} possibly)` : ""}`} |`
    )
  }
  out.push("")
  for (const p of g.detailed) out.push(...section(p, now), "")
  if (g.unseen.length > 0) {
    out.push("<details><summary>Cannot see how you use these</summary>", "")
    for (const p of g.unseen)
      out.push(`- \`${p.pkg}\` ${p.from} → ${p.to}: ${opaqueLabel(p)}`)
    out.push("", "</details>", "")
  }
  if (brief.limits.length > 0) {
    out.push("<details><summary>Limits</summary>", "")
    for (const l of brief.limits) out.push(`- ${l}`)
    out.push("", "</details>")
  }
  return `${out.join("\n")}\n`
}

function section(p: PackageBrief, now: number): string[] {
  const lines: string[] = []
  lines.push(`#### \`${p.pkg}\` ${p.from} → ${p.to}`)
  lines.push("")
  lines.push(
    `Published ${ago(p.publishedAt, now)} · ${coverageLabel(p)} · used in ${p.usage.files} files`
  )
  lines.push("")
  let unplaced = 0
  for (const f of orderFindings(p)) {
    if (f.kind === "type") {
      const t = f.touched
      lines.push(
        `- **${t.bucket}** \`${t.change.path}\`${t.strength === "weak" ? " (by member name)" : ""}`
      )
      for (const s of t.sites.slice(0, 5)) lines.push(`  - \`${siteLabel(s)}\``)
    } else if (f.kind === "note") {
      const m = f.match
      const names = [...new Set(m.hits.map((h) => h.name))]
      lines.push(
        `- ${m.entry.version}: ${m.entry.title}${m.direct ? "" : " _(possibly)_"}. ${capitalize(usedLabel(m.hits, (n) => `\`${n}\``))}`
      )
      const strong = m.hits
        .filter((h) => h.strength === "strong")
        .map((h) => h.name)
      for (const s of sitesFor(p, strong.length > 0 ? strong : names).slice(
        0,
        m.direct ? 3 : 1
      ))
        lines.push(`  - \`${siteLabel(s)}\``)
    } else if (f.kind === "breaking-no-api") {
      lines.push(
        `- ${f.entry.version}: ${f.entry.title} _(breaking, names no API)_`
      )
      lines.push(...likelyLine(f.entry))
    } else if (++unplaced <= UNPLACED_CAP) {
      lines.push(
        `- ${f.entry.version}: ${f.entry.title} _(a change radius cannot tie to your code)_`
      )
      lines.push(...likelyLine(f.entry))
    }
  }
  if (unplaced > UNPLACED_CAP)
    lines.push(
      `- and ${unplaced - UNPLACED_CAP} more ${unplaced - UNPLACED_CAP === 1 ? "change" : "changes"} radius cannot tie to your code`
    )
  lines.push("")
  lines.push(`<sub>${p.reasons.map((r) => r.detail).join(" · ")}</sub>`)
  return lines
}

// changes nothing ties to the code: a release has many, a comment shows the first few
const UNPLACED_CAP = 5

function likelyLine(e: UnplacedEntry): string[] {
  const label = likelyLabel(e, (n) => `\`${n}\``)
  return label ? [`  - _${label}_`] : []
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
