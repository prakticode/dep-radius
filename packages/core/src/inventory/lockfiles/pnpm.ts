import type { LockReader } from "./types.ts"

// pnpm-lock.yaml v6 to v9, read by indentation rather than with a YAML parser:
//   importers:
//     packages/app:
//       dependencies:
//         left-pad:
//           specifier: ^1.3.0
//           version: 1.3.0
export function pnpmLock(text: string): LockReader | undefined {
  const importers = new Map<string, Map<string, string>>()
  // v6+ records the specifier next to the version; v5 keeps them apart, and is left unchecked
  const specifiers = new Map<string, Map<string, string>>()
  const lines = text.split(/\r?\n/)
  let inImporters = false
  let importer: Map<string, string> | undefined
  let importerSpecs: Map<string, string> | undefined
  let inDeps = false
  let depKey: string | undefined

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const indent = line.length - line.trimStart().length
    const content = line.trim()
    if (indent === 0) {
      inImporters = content === "importers:"
      importer = undefined
      continue
    }
    if (!inImporters) continue
    if (indent === 2) {
      const name = unquote(content.replace(/:$/, ""))
      importer = new Map()
      importerSpecs = new Map()
      importers.set(name, importer)
      specifiers.set(name, importerSpecs)
      inDeps = false
      continue
    }
    if (indent === 4) {
      inDeps = /^(dependencies|devDependencies|optionalDependencies):$/.test(
        content
      )
      depKey = undefined
      continue
    }
    if (!importer || !inDeps) continue
    if (indent === 6) {
      // v5 inline form "left-pad: 1.3.0", or v6+ block form "left-pad:"
      const m = /^(.+?):\s*(.*)$/.exec(content)
      if (!m?.[1]) continue
      depKey = unquote(m[1])
      if (m[2]) importer.set(depKey, m[2])
      continue
    }
    if (indent === 8 && depKey) {
      const m = /^version:\s*(.+)$/.exec(content)
      if (m?.[1]) importer.set(depKey, unquote(m[1]))
      const s = /^specifier:\s*(.+)$/.exec(content)
      if (s?.[1]) importerSpecs?.set(depKey, unquote(s[1]))
    }
  }
  if (importers.size === 0) return undefined

  return {
    source: "lockfile:pnpm",
    lookup(manifestDir, key) {
      const raw = importers.get(manifestDir)?.get(key)
      if (!raw || raw.startsWith("link:") || raw.startsWith("file:"))
        return undefined
      // "4.5.4(typescript@6.0.3)" -> 4.5.4 ; "/left-pad/1.3.0" (v5) -> 1.3.0 ; "npm:x@1.0.0" style handled below
      let v = raw.replace(/\(.*$/, "")
      let name = key
      const alias = /^(@?[^@]+)@(\d.*)$/.exec(v)
      if (alias?.[1] && alias[2]) {
        name = alias[1]
        v = alias[2]
      }
      v = v.replace(/^\/.*\//, "")
      const specs = specifiers.get(manifestDir)
      const specifier =
        specs && specs.size > 0 ? (specs.get(key) ?? null) : undefined
      return /^\d/.test(v)
        ? {
            version: v,
            name,
            ...(specifier !== undefined ? { specifier } : {}),
          }
        : undefined
    },
  }
}

function unquote(s: string): string {
  const t = s.trim()
  return (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
    ? t.slice(1, -1)
    : t
}
