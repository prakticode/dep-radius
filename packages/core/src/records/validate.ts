import type { NoteEntry, Surface, SurfaceSymbol } from "../model.ts"
import { type ChangeRecord, parseSubject, RECORD_SCHEMA } from "./record.ts"

export interface RecordSurfaces {
  from: Surface
  to: Surface
}

// Records made outside the run only ever add subjects, and only subjects that exist: an API removed
// by the upgrade is in the old version's types, one it adds is in the new version's. A record for
// an entry these notes do not have is dropped; without types, subjects cannot be checked here, and
// the join ties them by name only.
export function validateRecords(
  records: ChangeRecord[],
  entries: NoteEntry[],
  surfaces?: RecordSurfaces
): ChangeRecord[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const out: ChangeRecord[] = []
  for (const r of records) {
    const entry = byId.get(r.entry)
    if (!entry || entry.version !== r.version) continue
    const subjects = [
      ...new Set(
        surfaces
          ? r.subjects.filter(
              (s) => exists(surfaces.from, s) || exists(surfaces.to, s)
            )
          : r.subjects
      ),
    ].sort()
    const { mentions: _m, namesApi: _n, ...rest } = r
    out.push({ ...rest, subjects })
  }
  return out
}

function exists(surface: Surface, subject: string): boolean {
  const { path, option } = parseSubject(subject)
  let sym: SurfaceSymbol | undefined = surface.symbols[path]
  if (!sym) return false
  if (option === undefined) return true
  for (let i = 0; i < 5 && sym && !sym.options && sym.aliasOf; i++)
    sym = surface.symbols[sym.aliasOf]
  return sym?.options?.includes(option) ?? false
}

// The shape a record file must have: anything else, or another schema, is ignored.
export function isRecord(value: unknown): value is ChangeRecord {
  if (!value || typeof value !== "object") return false
  const r = value as Record<string, unknown>
  return (
    r.schema === RECORD_SCHEMA &&
    typeof r.entry === "string" &&
    typeof r.version === "string" &&
    typeof r.kind === "string" &&
    typeof r.breaking === "boolean" &&
    Array.isArray(r.subjects) &&
    r.subjects.every((s) => typeof s === "string") &&
    typeof r.what === "string" &&
    (r.source === "rules" || r.source === "ai") &&
    typeof r.extractor === "string"
  )
}
