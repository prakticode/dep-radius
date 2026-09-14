import type { ImplementationFacts } from "./model.ts"
import type { CanonPath, RawRef, Site } from "../../model.ts"
import { effectiveChain, entryPrefix } from "../../symbol-path.ts"

// The exports a project's references reach, spelled as the facts spell them, with the sites that
// reach each one. Without types the chain is read as written: `persist(...)` is `lib:persist`,
// `Store.create()` is `lib:Store.create` or `lib:Store#create`, a default import called is the
// module itself.
export function usedExports(
  pkg: string,
  refs: RawRef[],
  facts: ImplementationFacts
): Map<CanonPath, Site[]> {
  const out = new Map<CanonPath, Site[]>()
  for (const r of refs) {
    const ref =
      r.binding.kind === "derived" && r.origin
        ? {
            ...r,
            binding: r.origin.binding,
            entry: r.origin.entry,
            chain: [...r.origin.chain, ...r.chain],
            callSelf: r.origin.callSelf,
          }
        : r
    if (ref.binding.kind === "derived") continue
    const prefix = entryPrefix(pkg, ref.entry)
    const { segs, startsCalled } = effectiveChain(ref)
    const candidates: string[] = []
    const [a, b] = segs
    if (a && !startsCalled) {
      candidates.push(`${prefix}:${a.name}`)
      if (b)
        candidates.push(
          `${prefix}:${a.name}#${b.name}`,
          `${prefix}:${a.name}.${b.name}`
        )
    }
    if (a && startsCalled) candidates.push(`${prefix}:#${a.name}`)
    // ESM `export default lib` with `lib.get()`
    if (a && ref.binding.kind === "default")
      candidates.push(
        `${prefix}:default.${a.name}`,
        `${prefix}:default#${a.name}`
      )
    const found = candidates.filter((c) => facts.exports[c])
    // the module itself, when the reference names nothing more precise
    if (found.length === 0)
      found.push(
        ...[`${prefix}:`, `${prefix}:default`].filter((c) => facts.exports[c])
      )
    for (const c of found) {
      const list = out.get(c) ?? []
      list.push(r.site)
      out.set(c, list)
    }
  }
  return out
}

// The exports of the entry points a project imports: what it could use without a new import.
export function reachableEntryExports(
  pkg: string,
  refs: RawRef[],
  facts: ImplementationFacts
): CanonPath[] {
  const prefixes = new Set(
    refs.map((r) => `${entryPrefix(pkg, r.origin?.entry ?? r.entry)}:`)
  )
  return Object.keys(facts.exports).filter((p) =>
    [...prefixes].some((prefix) => p.startsWith(prefix))
  )
}
