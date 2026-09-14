import { reach } from "./graph.ts"
import type {
  ChangedExport,
  ImplementationDiff,
  ImplementationFacts,
} from "./model.ts"

// name -> sorted fingerprints: files and unit numbers move between builds, names and code do not
function byName(
  facts: ImplementationFacts,
  ids: Iterable<number>
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const minified = new Set(facts.minified)
  for (const i of ids) {
    const u = facts.units[i]
    if (!u) continue
    // a minifier renames functions between builds, never the methods and properties it cannot see
    const key =
      minified.has(u.file) && u.kind !== "method"
        ? `(minified ${u.kind})`
        : u.name
    const list = out.get(key) ?? []
    list.push(u.fp)
    out.set(key, list)
  }
  for (const list of out.values()) list.sort()
  return out
}

function differing(
  a: Map<string, string[]>,
  b: Map<string, string[]>
): string[] {
  const names = new Set([...a.keys(), ...b.keys()])
  return [...names]
    .filter((n) => (a.get(n) ?? []).join(",") !== (b.get(n) ?? []).join(","))
    .sort()
}

// Which exports run different code in the new version. An export changed when the code it can reach
// differs: a unit's fingerprint, a unit appearing or disappearing. Present in both versions only;
// exports that come or go are the type surface's business, listed for completeness.
export function diffImplementations(
  a: ImplementationFacts,
  b: ImplementationFacts
): ImplementationDiff {
  const changed: ChangedExport[] = []
  let unchanged = 0
  const pathsA = Object.keys(a.exports).sort()
  const inB = new Set(Object.keys(b.exports))
  for (const path of pathsA) {
    if (!inB.has(path)) continue
    const units = differing(
      byName(a, reach(a, path)),
      byName(b, reach(b, path))
    )
    if (units.length > 0) changed.push({ path, units })
    else unchanged++
  }
  const all = (f: ImplementationFacts) => f.units.map((_, i) => i)
  return {
    changed,
    unchanged,
    added: Object.keys(b.exports)
      .filter((p) => !(p in a.exports))
      .sort(),
    removed: pathsA.filter((p) => !inB.has(p)),
    changedUnits: differing(byName(a, all(a)), byName(b, all(b))),
    flags: [...new Set([...a.flags, ...b.flags])].sort(),
  }
}
