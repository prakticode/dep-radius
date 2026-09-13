import type { Brief, PackageBrief } from "../model.ts"

// Only the limits that bore on this run, so the footer stays read.
export function limitsFor(
  packages: PackageBrief[],
  global: Brief["global"]
): string[] {
  const out: string[] = []
  if (packages.length === 0) return out
  out.push(
    "Behaviour changes are seen only through release notes; the types and the notes are counted separately, never merged."
  )
  if (packages.some((p) => p.usage.weakNames.length > 0))
    out.push(
      "No type checker runs over your code: members reached through values from other files or callbacks are matched by name only."
    )
  if (
    packages.some(
      (p) =>
        p.surface.status === "no-types" ||
        p.surface.status === "types-from-@types"
    )
  )
    out.push(
      "Packages without their own types are judged from release notes alone; @types packages are analysed as their own dependency."
    )
  if (
    packages.some(
      (p) => p.notes.coverage !== "complete" && p.notes.coverage !== "disabled"
    )
  )
    out.push(
      "Release notes are read from the package's changelog and GitHub only; other hosts count as unavailable."
    )
  const g = new Map(global.map((x) => [x.kind, x.count]))
  const dyn =
    (g.get("dynamic-import-nonliteral") ?? 0) +
    (g.get("require-nonliteral") ?? 0)
  if (dyn > 0)
    out.push(
      `${dyn} import() or require() calls with a computed name could not be attributed to any package.`
    )
  if (g.get("unparseable-file"))
    out.push(
      `${g.get("unparseable-file")} files did not parse cleanly; names in them may be missing.`
    )
  if (
    packages.some((p) =>
      p.usage.opaque.some((o) => o.kind === "convention-framework")
    )
  )
    out.push(
      "Frameworks used through file conventions are never judged quiet: their imports show little of what depends on them."
    )
  out.push(
    "Local names that shadow an import are not analysed, and transitive dependencies are out of scope."
  )
  return out
}
