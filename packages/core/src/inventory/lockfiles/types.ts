import type { VersionSource } from "../../model.ts"

export interface LockReader {
  source: VersionSource
  // manifestDir is relative to the lockfile's folder, "." for the root manifest
  lookup(
    manifestDir: string,
    key: string,
    spec: string
  ): { version: string; name: string } | undefined
}
