import type { VersionSource } from "../../model.ts"

export interface LockReader {
  source: VersionSource
  // manifestDir is relative to the lockfile's folder, "." for the root manifest
  lookup(manifestDir: string, key: string, spec: string): LockHit | undefined
}

export interface LockHit {
  version: string
  name: string
  // the specifier the lockfile recorded for this manifest's dependency when it was written: a string,
  // null when the lockfile lists the manifest's dependencies without this one, undefined when this
  // lockfile format records none. A specifier other than the manifest's means the manifest changed
  // after the last install, which is what `npm ci` and `pnpm install --frozen-lockfile` refuse.
  specifier?: string | null
}
