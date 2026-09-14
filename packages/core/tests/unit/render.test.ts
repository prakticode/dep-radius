import { describe, expect, it } from "vitest"

import { renderMarkdown } from "../../src/render/markdown.ts"
import { type Finding, orderFindings } from "../../src/render/groups.ts"
import type {
  Brief,
  NoteEntry,
  NoteMatch,
  PackageBrief,
  Touched,
} from "../../src/model.ts"

const NOW = Date.parse("2026-09-13T09:00:00Z")

const entry = (title: string, breaking = false): NoteEntry => ({
  id: title,
  version: "1.1.0",
  title,
  headingPath: [],
  regions: [{ kind: "title", text: title }],
  breakingMarker: breaking,
  noise: false,
  kind: "change",
  refs: [],
})

const note = (
  title: string,
  breaking: boolean,
  direct: boolean
): NoteMatch => ({
  entry: entry(title, breaking),
  hits: [
    { name: "parse", strength: direct ? "strong" : "weak", region: "title" },
  ],
  direct,
})

const touched = (
  path: string,
  bucket: Touched["bucket"],
  strength: Touched["strength"]
): Touched => ({
  change: { path, kind: "function", alsoAt: [] },
  bucket,
  strength,
  sites: [],
})

function pkg(): PackageBrief {
  return {
    pkg: "lib",
    from: "1.0.0",
    to: "1.1.0",
    bump: "minor",
    publishedAt: "2026-09-10T09:00:00Z",
    versionSource: "node_modules",
    manifests: ["package.json"],
    level: 1,
    verdict: "blocked",
    reasons: [],
    surface: {
      status: "computed",
      changes: 3,
      touched: [
        touched("lib:gone", "removed", "strong"),
        touched("lib:parse", "changed", "strong"),
        touched("lib:Schema#issues", "changed", "weak"),
      ],
    },
    notes: {
      coverage: "complete",
      perVersion: [],
      total: 5,
      matched: [
        note("Faster parse", false, true),
        note("parse rejects empty input", true, true),
        note("Schema issues are frozen", true, false),
        note("parse docs", false, false),
      ],
      unattributedBreaking: [entry("Drop Node 18", true)],
      unattributedChanges: [],
    },
    usage: {
      files: 1,
      sites: [],
      byName: {},
      strongNames: ["parse"],
      weakNames: [],
      opaque: [],
      blindSpots: [],
    },
    skippedNewer: [],
  }
}

const label = (f: Finding): string =>
  f.kind === "type"
    ? f.touched.change.path
    : f.kind === "note"
      ? f.match.entry.title
      : f.entry.title

describe("orderFindings", () => {
  it("puts what breaks your code first and what possibly concerns it last", () => {
    expect(orderFindings(pkg()).map(label)).toEqual([
      "lib:gone",
      "parse rejects empty input",
      "lib:parse",
      "Faster parse",
      "Schema issues are frozen",
      "Drop Node 18",
      "lib:Schema#issues",
      "parse docs",
    ])
  })

  it("orders the pull request comment the same way, leaving nothing out", () => {
    const brief: Brief = {
      schemaVersion: 1,
      tool: { version: "0.0.0", typescript: "6.0.3" },
      root: "/project",
      generatedAt: new Date(NOW).toISOString(),
      manifests: 1,
      upToDate: 0,
      notAnalyzed: [],
      global: [],
      limits: [],
      exitCode: 2,
      packages: [pkg()],
    }
    const md = renderMarkdown(brief, NOW)
    const at = (s: string) => md.indexOf(s)
    const order = orderFindings(pkg()).map(label)
    for (const s of order) expect(at(s)).toBeGreaterThan(-1)
    for (let i = 1; i < order.length; i++)
      expect(at(order[i]!)).toBeGreaterThan(at(order[i - 1]!))
  })
})
