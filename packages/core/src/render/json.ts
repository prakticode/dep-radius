import type {
  Brief,
  Counted,
  NoteEntry,
  PackageBrief,
  Site,
  VerdictReason,
} from "../model.ts"

// The public --json contract, version 1, described by schema/brief-v1.schema.json. The internal
// Brief is free to change; this shape is not. A field is added only with the schema, and removed or
// renamed only with schemaVersion 2.

export interface SiteV1 {
  file: string
  line: number
  column: number
  typeOnly: boolean
  code: string
  via?: string[]
}

export interface CannotSeeV1 {
  kind: string
  count: number
  examples: SiteV1[]
}

export interface PackageV1 {
  name: string
  from: string
  to: string
  bump: "major" | "minor" | "patch"
  publishedAt: string
  verdict: "quiet" | "review" | "blocked"
  reasons: VerdictReason[]
  versionSource: string
  manifests: string[]
  types: {
    status: string
    detail?: string
    changes?: number
    added?: number
    touched: {
      path: string
      alsoAt: string[]
      change: "removed" | "changed" | "deprecated"
      certainty: "exact" | "by-name"
      before?: string[]
      after?: string[]
      sites: SiteV1[]
    }[]
  }
  notes: {
    coverage: string
    entries: number
    versions: {
      version: string
      status: string
      source?: { kind: string; url: string }
      reason?: string
    }[]
    matched: {
      version: string
      title: string
      breaking: boolean
      direct: boolean
      refs: string[]
      names: { name: string; certainty: "exact" | "by-name"; where: string }[]
    }[]
    breakingWithoutApi: { version: string; title: string; refs: string[] }[]
    changesWithoutApi: { version: string; title: string; refs: string[] }[]
  }
  usage: {
    files: number
    sites: number
    names: { exact: string[]; byName: string[] }
    sitesByName: Record<string, SiteV1[]>
    cannotSee: CannotSeeV1[]
  }
  heldBack: { version: string; reason: string; publishedAt?: string }[]
  alsoAvailable?: { version: string; bump: string }
}

export interface BriefV1 {
  schemaVersion: 1
  tool: { name: "dep-radius"; version: string; typescript: string }
  root: string
  generatedAt: string
  since?: { ref: string; commit: string }
  exitCode: 0 | 1 | 2
  summary: {
    manifests: number
    withUpdate: number
    upToDate: number
    quiet: number
    review: number
    blocked: number
    notAnalyzed: number
  }
  packages: PackageV1[]
  notAnalyzed: { name: string; reason: string }[]
  wholeProject: CannotSeeV1[]
  limits: string[]
}

export function toJsonV1(brief: Brief): BriefV1 {
  const count = (v: PackageBrief["verdict"]) =>
    brief.packages.filter((p) => p.verdict === v).length
  return {
    schemaVersion: 1,
    tool: {
      name: "dep-radius",
      version: brief.tool.version,
      typescript: brief.tool.typescript,
    },
    root: brief.root,
    generatedAt: brief.generatedAt,
    ...(brief.since ? { since: brief.since } : {}),
    exitCode: brief.exitCode,
    summary: {
      manifests: brief.manifests,
      withUpdate: brief.packages.length,
      upToDate: brief.upToDate,
      quiet: count("quiet"),
      review: count("review"),
      blocked: count("blocked"),
      notAnalyzed: brief.notAnalyzed.length,
    },
    packages: brief.packages.map(packageV1),
    notAnalyzed: brief.notAnalyzed.map((n) => ({
      name: n.pkg,
      reason: n.reason,
    })),
    wholeProject: brief.global.map(countedV1),
    limits: brief.limits,
  }
}

export function renderJson(brief: Brief): string {
  return `${JSON.stringify(toJsonV1(brief), null, 2)}\n`
}

function packageV1(p: PackageBrief): PackageV1 {
  return {
    name: p.pkg,
    from: p.from,
    to: p.to,
    bump: p.bump,
    publishedAt: p.publishedAt,
    verdict: p.verdict,
    reasons: p.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    versionSource: p.versionSource,
    manifests: p.manifests,
    types: {
      status: p.surface.status,
      ...(p.surface.detail !== undefined ? { detail: p.surface.detail } : {}),
      ...(p.surface.changes !== undefined
        ? { changes: p.surface.changes }
        : {}),
      ...(p.surface.added !== undefined ? { added: p.surface.added } : {}),
      touched: p.surface.touched.map((t) => ({
        path: t.change.path,
        alsoAt: t.change.alsoAt,
        change: t.bucket,
        certainty: t.strength === "strong" ? "exact" : "by-name",
        ...(t.change.before ? { before: t.change.before } : {}),
        ...(t.change.after ? { after: t.change.after } : {}),
        sites: t.sites.map(siteV1),
      })),
    },
    notes: {
      coverage: p.notes.coverage,
      entries: p.notes.total,
      versions: p.notes.perVersion.map((v) => ({
        version: v.version,
        status: v.status,
        ...(v.source
          ? { source: { kind: v.source.kind, url: v.source.url } }
          : {}),
        ...(v.reason ? { reason: v.reason } : {}),
      })),
      matched: p.notes.matched.map((m) => ({
        version: m.entry.version,
        title: m.entry.title,
        breaking: m.entry.breakingMarker,
        direct: m.direct,
        refs: m.entry.refs,
        names: m.hits.map((h) => ({
          name: h.name,
          certainty: h.strength === "strong" ? "exact" : "by-name",
          where: h.region,
          ...(h.option ? { option: true } : {}),
        })),
      })),
      breakingWithoutApi: p.notes.unattributedBreaking.map(entryV1),
      changesWithoutApi: p.notes.unattributedChanges.map(entryV1),
    },
    usage: {
      files: p.usage.files,
      sites: p.usage.sites.length,
      names: { exact: p.usage.strongNames, byName: p.usage.weakNames },
      sitesByName: Object.fromEntries(
        Object.entries(p.usage.byName).map(([name, sites]) => [
          name,
          sites.map(siteV1),
        ])
      ),
      cannotSee: [
        ...p.usage.opaque.map(countedV1),
        ...p.usage.blindSpots.map(countedV1),
      ],
    },
    heldBack: p.skippedNewer.map((s) => ({
      version: s.version,
      reason: s.reason,
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
    })),
    ...(p.alsoAvailable
      ? {
          alsoAvailable: {
            version: p.alsoAvailable.version,
            bump: p.alsoAvailable.bump,
          },
        }
      : {}),
  }
}

function siteV1(s: Site): SiteV1 {
  return {
    file: s.file,
    line: s.line,
    column: s.col,
    typeOnly: s.typeOnly,
    code: s.text,
    ...(s.via && s.via.length > 0 ? { via: s.via } : {}),
  }
}

function countedV1(c: Counted<string>): CannotSeeV1 {
  return { kind: c.kind, count: c.count, examples: c.examples.map(siteV1) }
}

function entryV1(e: NoteEntry): {
  version: string
  title: string
  refs: string[]
} {
  return { version: e.version, title: e.title, refs: e.refs }
}
