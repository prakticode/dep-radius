import { join } from "node:path"
import { readFile } from "node:fs/promises"

import semver from "semver"

import { isRecord } from "./validate.ts"
import type { ChangeRecord } from "./record.ts"

// Records kept on disk, one file per package version: <dir>/<name>@<version>.json holding an array
// of records, a scope written with a double underscore (@scope__name@1.0.0.json).
export function recordFileName(pkg: string, version: string): string {
  return `${pkg.replace("/", "__")}@${version}.json`
}

export async function loadRecords(
  dir: string,
  pkg: string,
  versions: string[]
): Promise<ChangeRecord[]> {
  const out: ChangeRecord[] = []
  for (const version of [...new Set(versions)].sort(compareVersions)) {
    let raw: unknown
    try {
      raw = JSON.parse(
        await readFile(join(dir, recordFileName(pkg, version)), "utf8")
      )
    } catch {
      continue
    }
    if (!Array.isArray(raw)) continue
    for (const r of raw)
      if (isRecord(r) && r.version === version) out.push(normalize(r))
  }
  return sortRecords(dedupe(out))
}

function normalize(r: ChangeRecord): ChangeRecord {
  return { ...r, subjects: [...new Set(r.subjects)].sort() }
}

function dedupe(records: ChangeRecord[]): ChangeRecord[] {
  const seen = new Set<string>()
  return records.filter((r) => {
    const key = JSON.stringify(r)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// The same records in the same order whatever order the files list them in.
export function sortRecords(records: ChangeRecord[]): ChangeRecord[] {
  return [...records].sort(
    (a, b) =>
      compareVersions(a.version, b.version) ||
      cmp(a.entry, b.entry) ||
      cmp(a.source, b.source) ||
      cmp(a.extractor, b.extractor) ||
      cmp(JSON.stringify(a.subjects), JSON.stringify(b.subjects))
  )
}

function compareVersions(a: string, b: string): number {
  return semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : cmp(a, b)
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
