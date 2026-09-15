// The one set of types every stage reads and writes. Renderers only ever see a Brief.

// ---------------------------------------------------------------- inventory

export type VersionSource =
  | "node_modules"
  | "lockfile:npm"
  | "lockfile:pnpm"
  | "lockfile:yarn"
  | "lockfile:bun"
  | "manifest-range"

export type DepField =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies"

export type SpecKind =
  | "range"
  | "tag"
  | "alias"
  | "workspace"
  | "catalog"
  | "link"
  | "file"
  | "git"
  | "url"

export interface DeclaredDep {
  key: string
  spec: string
  field: DepField
  specKind: SpecKind
  aliasOf?: string
}

export interface Manifest {
  path: string
  dir: string
  name?: string
  private: boolean
  deps: DeclaredDep[]
  scripts: Record<string, string>
  exports?: unknown
  main?: string
  module?: string
  types?: string
}

export type InstalledFlag =
  | "alias"
  | "patched"
  | "not-in-registry"
  | "prerelease-installed"
  | "range-guess"

export interface InstalledDep {
  // realpath of the installed folder, or `${source}:${name}@${version}` when nothing is on disk
  id: string
  name: string
  version: string
  versionSource: VersionSource
  dir?: string
  local: boolean
  declaredBy: { manifest: string; key: string; field: DepField }[]
  flags: InstalledFlag[]
}

export interface NotAnalyzed {
  pkg: string
  reason: string
}

export interface Inventory {
  root: string
  manifests: Manifest[]
  installed: InstalledDep[]
  local: string[]
  notAnalyzed: NotAnalyzed[]
}

// ---------------------------------------------------------------- registry

export type Bump = "major" | "minor" | "patch"

export interface Candidate {
  pkg: string
  from: string
  to: string
  bump: Bump
  publishedAt: string
  range: string[]
  skippedNewer: {
    version: string
    reason: "too-new" | "deprecated" | "above-dist-tag"
    publishedAt?: string
  }[]
  alsoAvailable?: { version: string; bump: Bump }
}

// ---------------------------------------------------------------- usage

export interface ChainSeg {
  name: string
  call: boolean
  construct?: boolean
}

export interface Site {
  file: string
  line: number
  col: number
  typeOnly: boolean
  text: string
  via?: string[]
}

export type Binding =
  | { kind: "named"; imported: string }
  | { kind: "namespace" }
  | { kind: "default" }
  | { kind: "cjs" }
  | { kind: "derived" }

// How a derived value was built: `const schema = v.object({...})` has origin { namespace, [object()] }
export interface RefOrigin {
  binding: Exclude<Binding, { kind: "derived" }>
  entry: string
  chain: ChainSeg[]
  callSelf: boolean
}

export interface RawRef {
  installedId: string
  pkg: string
  specifier: string
  entry: string
  binding: Binding
  chain: ChainSeg[]
  callSelf: boolean
  site: Site
  // set on derived references when the value's construction is known, so Level 1 can keep walking
  origin?: RefOrigin
  // the keys of object literals this reference passes to its calls, each where it is written
  passed?: Record<string, Site>
}

export type OpaqueKind =
  | "side-effect-import"
  | "config-reference"
  | "script-bin"
  | "css-import"
  | "convention-framework"
  | "ambient-types"

export type BlindSpotKind =
  | "namespace-escape"
  | "computed-member"
  | "dynamic-import-escape"
  | "prefix-dynamic-import"
  | "public-reexport"
  | "unresolved-local-import"
  | "derived-escape"
  | "unparseable-file"
  | "unresolved-against-surface"

export type GlobalBlindSpotKind =
  | "dynamic-import-nonliteral"
  | "require-nonliteral"
  | "skipped-generated"
  | "unparseable-file"

export interface Counted<K extends string> {
  kind: K
  count: number
  examples: Site[]
}

export interface PackageUsage {
  installedId: string
  pkg: string
  refs: RawRef[]
  strongNames: string[]
  weakNames: string[]
  files: number
  opaque: Counted<OpaqueKind>[]
  blindSpots: Counted<BlindSpotKind>[]
  // the keys of objects the code passes to the package's calls, with the calls: the option names
  // known without types
  passedOptions?: Record<string, Site[]>
}

export interface UsageMap {
  scannedFiles: number
  packages: Record<string, PackageUsage>
  global: Counted<GlobalBlindSpotKind>[]
}

// ---------------------------------------------------------------- surface

export type CanonPath = string

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "enum-member"
  | "namespace"
  | "member"
  | "static-member"

export interface SurfaceSymbol {
  path: CanonPath
  kind: SymbolKind
  sig: string[]
  deprecated: boolean
  returns?: CanonPath
  instanceOf?: CanonPath
  aliasOf?: CanonPath
  // the property names of the objects its parameters take: `config(options?: { quiet?: boolean })`
  options?: string[]
  // a class or interface extending a type the surface cannot load: its inherited members are unseen
  unresolvedBase?: true
}

export type SurfaceFlag =
  "wildcard-truncated" | "symbol-cap" | "external-types-unresolved"

export interface Surface {
  pkg: string
  version: string
  integrity: string
  ts: string
  algo: number
  typesFrom: "package" | "@types"
  // externalReexports: `export * from "other-lib"` naming a package the surface cannot load
  entries: Record<
    string,
    { typesFile: string; exportEquals: boolean; externalReexports?: string[] }
  >
  // dependency -> version whose declarations were loaded next to the package's own
  dependencyTypes?: Record<string, string>
  symbols: Record<CanonPath, SurfaceSymbol>
  flags: SurfaceFlag[]
}

export interface SurfaceChange {
  path: CanonPath
  kind: SymbolKind
  before?: string[]
  after?: string[]
  alsoAt: CanonPath[]
}

// Missing from the new surface, but the new surface could not have shown it: not proof of a removal
export type UnprovenCause =
  "external-reexport" | "symbol-cap" | "subpath-cap" | "unresolved-base"

export interface UnprovenRemoval extends SurfaceChange {
  cause: UnprovenCause
}

export interface SurfaceDelta {
  removed: SurfaceChange[]
  unproven: UnprovenRemoval[]
  changed: SurfaceChange[]
  deprecated: SurfaceChange[]
  widened: SurfaceChange[]
  added: SurfaceChange[]
}

// ---------------------------------------------------------------- notes

export type NoteSourceKind =
  "tarball-changelog" | "github-release" | "repo-changelog"

export interface VersionNotes {
  version: string
  status: "found" | "not-published" | "unavailable"
  source?: { kind: NoteSourceKind; url: string }
  reason?:
    | "offline"
    | "rate-limited"
    | "no-repo"
    | "unsupported-host"
    | "http-error"
    | "stub-body"
}

export type RegionKind = "title" | "prose" | "inline-code" | "code-block"

export interface NoteEntry {
  id: string
  version: string
  title: string
  headingPath: string[]
  regions: { kind: RegionKind; text: string }[]
  breakingMarker: boolean
  // housekeeping: never matched, never counted as a change
  noise: boolean
  kind: EntryKind
  refs: string[]
}

// What an entry says about the package, whatever it names:
// - change: behaviour may differ for existing code (the default)
// - addition: something new that existing code doesn't use yet
// - types: only the TypeScript declarations changed, which the type surface compares
// - housekeeping: the project's own tests, docs, CI, dependencies, thanks
// - intro: the sentence that opens a release before its list of changes
// - reference: a pointer to a guide or a post, with nothing said in the entry itself
export type EntryKind =
  "change" | "addition" | "types" | "housekeeping" | "intro" | "reference"

export interface NoteHit {
  name: string
  strength: "strong" | "weak"
  region: RegionKind
  // an option a function you call accepts, whether or not the code passes it
  option?: true
  // the API of a change record the hit comes from, rather than a name in the note's words
  subject?: string
}

export interface NoteMatch {
  entry: NoteEntry
  hits: NoteHit[]
  // a name you use strongly, written in the note's own words rather than only in its example code
  direct: boolean
}

// A note radius cannot tie to the code by name, whose code names meet the package's code that
// changed under an export the project uses: `setItem`, called inside `persist`, which the project
// calls. A hint, weaker than a name match: it never changes a verdict.
export interface LikelyReach {
  // the export the project uses whose code changed
  export: CanonPath
  // the note's names found in that changed code: a changed function, or what one calls
  via: string[]
  sites: Site[]
}

export interface UnplacedEntry extends NoteEntry {
  likely?: LikelyReach[]
}

export type NotesCoverage =
  "complete" | "partial" | "none-published" | "unavailable" | "disabled"

// ---------------------------------------------------------------- brief

export type Verdict = "quiet" | "review" | "blocked"

export type ReasonCode =
  | "removed-touched"
  | "changed-touched"
  | "deprecated-touched"
  | "possibly-touched"
  | "notes-match"
  | "unattributed-breaking"
  | "unattributed-change"
  | "blind-spots"
  | "opaque-usage"
  | "not-referenced"
  | "flagged-install"
  | "surface-incomplete"
  | "no-evidence"
  | "major-unproven"
  | "notes-complete-no-match"
  | "surface-clean"
  | "caveat-no-types"
  | "caveat-no-notes"

export interface VerdictReason {
  code: ReasonCode
  detail: string
}

export interface Touched {
  change: SurfaceChange
  bucket: "removed" | "changed" | "deprecated"
  strength: "strong" | "weak"
  sites: Site[]
}

// types-elsewhere: the package's declarations re-export another package's, which radius does not follow
export type SurfaceStatus =
  | "computed"
  | "no-types"
  | "types-from-@types"
  | "types-elsewhere"
  | "failed"
  | "disabled"
  | "offline-uncached"

export interface PackageBrief {
  pkg: string
  from: string
  to: string
  bump: Bump
  publishedAt: string
  versionSource: VersionSource
  manifests: string[]
  level: 0 | 1
  verdict: Verdict
  reasons: VerdictReason[]
  surface: {
    status: SurfaceStatus
    detail?: string
    changes?: number
    added?: number
    touched: Touched[]
  }
  notes: {
    coverage: NotesCoverage
    perVersion: VersionNotes[]
    total: number
    matched: NoteMatch[]
    unattributedBreaking: UnplacedEntry[]
    // changes no name ties to the code: they keep an update from being quiet
    unattributedChanges: UnplacedEntry[]
  }
  usage: {
    files: number
    sites: Site[]
    // every site, keyed by the name used there: what a note or a surface change points back to
    byName: Record<string, Site[]>
    strongNames: string[]
    weakNames: string[]
    opaque: Counted<OpaqueKind>[]
    blindSpots: Counted<BlindSpotKind>[]
  }
  skippedNewer: Candidate["skippedNewer"]
  alsoAvailable?: Candidate["alsoAvailable"]
}

export interface Brief {
  schemaVersion: 1
  tool: { version: string; typescript: string }
  root: string
  generatedAt: string
  // set when the brief compares the working tree with a commit instead of with the registry
  since?: { ref: string; commit: string }
  manifests: number
  packages: PackageBrief[]
  upToDate: number
  notAnalyzed: NotAnalyzed[]
  global: Counted<GlobalBlindSpotKind>[]
  limits: string[]
  exitCode: 0 | 1 | 2
}
