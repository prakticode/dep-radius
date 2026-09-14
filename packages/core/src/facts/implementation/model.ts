import type { CanonPath } from "../../model.ts"

// Bumped whenever parsing, the call graph or the fingerprint changes: cached facts from an older
// algorithm would compare unequal to fresh ones and read as a change.
export const IMPLEMENTATION_ALGO = 1

// A piece of code with a name, the grain at which a change is reported: a function, a class (its
// constructor and fields), a method, an object literal member, or a module-level value.
export interface ImplementationUnit {
  // qualified inside its file: `persist`, `createStorage/setItem`, `Store#get`, `Store.create`, `api.get`
  name: string
  file: string
  kind: "function" | "class" | "method" | "value"
  // a hash of the normalized tokens, with nested units replaced by their names
  fp: string
  // units this one may run or hand out: the static, conservative call graph
  calls: number[]
  // the member names it reads or calls on values the graph cannot follow (`storage.setItem`)
  members: string[]
}

export type ImplementationFlag =
  | "no-entry"
  | "file-cap"
  | "file-too-large"
  | "unit-cap"
  | "work-cap"
  | "wildcard-truncated"
  | "minified"
  | "unparseable-file"

export interface ImplementationFacts {
  pkg: string
  version: string
  integrity: string
  algo: number
  // the build read: two facts compare only when they read the same one
  flavor: "import" | "require"
  // entry subpath -> the file read for it
  entries: Record<string, string>
  units: ImplementationUnit[]
  // every export, spelled as symbol-path.ts spells it, with the units it starts from
  exports: Record<CanonPath, number[]>
  flags: ImplementationFlag[]
  files: number
  // files whose local names are mangled: their functions compare by code, not by name
  minified: string[]
}

export type ImplementationResult =
  | { ok: true; facts: ImplementationFacts }
  | {
      ok: false
      reason: "offline-uncached" | "failed" | "no-entry"
      detail?: string
    }

export interface ChangedExport {
  path: CanonPath
  // qualified names of the reachable units whose code differs, appeared or disappeared
  units: string[]
}

export interface ImplementationDiff {
  changed: ChangedExport[]
  unchanged: number
  added: CanonPath[]
  removed: CanonPath[]
  // qualified names of every unit whose code differs between the versions, reachable or not
  changedUnits: string[]
  flags: ImplementationFlag[]
}
