import { join, posix } from "node:path"
import { readFile } from "node:fs/promises"

import ts from "typescript"

import { STYLE_EXT } from "./files.ts"
import type { FileFacts } from "./parse.ts"
import type { LocalResolver } from "./resolve-local.ts"
import { packageNameOf } from "../inventory/specifiers.ts"
import type { InstalledDep, Inventory, OpaqueKind, Site } from "../model.ts"

// Packages consumed mostly through file conventions: their import surface says little about how
// much of the project depends on them.
export const CONVENTION_FRAMEWORKS = new Set([
  "next",
  "nuxt",
  "astro",
  "gatsby",
  "@remix-run/dev",
  "@react-router/dev",
  "@sveltejs/kit",
  "@docusaurus/core",
  "vitepress",
  "expo-router",
  "react-scripts",
  "@angular/core",
  "@nestjs/core",
])

const CONFIG_FILE =
  /(^|\/)([^/]*\.config\.[cm]?[jt]s|\.[a-z-]*rc(\.[cm]?[jt]s|\.json|\.ya?ml)?|[a-z-]*rc\.[cm]?js|tsconfig[^/]*\.json|jsconfig\.json|components\.json|turbo\.json|vercel\.json|biome\.jsonc?|renovate\.json5?|\.babelrc|babel\.config\.json|deno\.jsonc?)$/i

export type OpaqueHits = Map<string, Map<OpaqueKind, Site[]>>

export async function findOpaque(
  root: string,
  files: string[],
  facts: Map<string, FileFacts>,
  inventory: Inventory,
  resolver: LocalResolver
): Promise<OpaqueHits> {
  const hits: OpaqueHits = new Map()
  const add = (id: string, kind: OpaqueKind, s: Site) => {
    let m = hits.get(id)
    if (!m) {
      m = new Map()
      hits.set(id, m)
    }
    const list = m.get(kind) ?? []
    list.push(s)
    m.set(kind, list)
  }

  const byName = new Map<string, InstalledDep[]>()
  for (const d of inventory.installed) {
    for (const n of new Set([d.name, ...d.declaredBy.map((x) => x.key)])) {
      const l = byName.get(n) ?? []
      if (!l.includes(d)) l.push(d)
      byName.set(n, l)
    }
  }
  const depsFor = (value: string): InstalledDep[] => {
    const name = packageNameOf(value)
    if (!name) return []
    if (value !== name && !value.startsWith(`${name}/`)) return []
    return byName.get(name) ?? []
  }

  // string references in JS or TS config files: plugins: ["prettier-plugin-tailwindcss"]
  for (const [rel, f] of facts) {
    if (!CONFIG_FILE.test(rel)) continue
    for (const s of f.stringLiterals) {
      for (const d of depsFor(s.value))
        add(d.id, "config-reference", site(rel, s.pos.line, s.pos.text))
    }
  }

  // JSON configs, and the non-dependency fields of manifests ("prettier": "@acme/prettier-config")
  for (const rel of files) {
    const isManifest = rel === "package.json" || rel.endsWith("/package.json")
    const isJsonConfig =
      /\.(json|jsonc|json5)$/i.test(rel) && CONFIG_FILE.test(rel)
    const isRc = /(^|\/)\.[a-z-]*rc$/i.test(rel)
    if (!isManifest && !isJsonConfig && !isRc) continue
    let text: string
    try {
      text = await readFile(join(root, rel), "utf8")
    } catch {
      continue
    }
    const parsed = ts.parseConfigFileTextToJson(rel, text)
    const json = parsed.config as unknown
    if (json === undefined) continue
    const strings: string[] = []
    collectStrings(json, strings, isManifest)
    for (const value of strings) {
      for (const d of depsFor(value))
        add(
          d.id,
          "config-reference",
          site(rel, lineOfString(text, value), value)
        )
    }
  }

  // binaries run from scripts: "lint": "eslint . --max-warnings 0"
  const binOwners = new Map<string, InstalledDep[]>()
  for (const d of inventory.installed) {
    for (const bin of await binNames(d)) {
      const l = binOwners.get(bin) ?? []
      l.push(d)
      binOwners.set(bin, l)
    }
  }
  for (const m of inventory.manifests) {
    const mRel = posix.relative(
      root.split("\\").join("/"),
      m.path.split("\\").join("/")
    )
    for (const [name, script] of Object.entries(m.scripts)) {
      for (const token of script.split(/[\s;&|()]+/)) {
        const owners = binOwners.get(token)
        if (!owners) continue
        for (const d of owners) {
          if (d.declaredBy.length === 0) continue
          add(
            d.id,
            "script-bin",
            site(mRel, 1, `${name}: ${script}`.slice(0, 160))
          )
        }
      }
    }
  }

  // stylesheets: @import "tailwindcss"; @plugin "@tailwindcss/typography"
  for (const rel of files) {
    if (!STYLE_EXT.test(rel)) continue
    let text: string
    try {
      text = await readFile(join(root, rel), "utf8")
    } catch {
      continue
    }
    const re =
      /@(import|plugin|config|source|use|forward|reference)\s+(?:url\()?\s*["']([^"']+)["']/g
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const spec = (m[2] ?? "").replace(/^~/, "")
      if (!packageNameOf(spec)) continue
      const t = await resolver.resolve(rel, spec)
      const line = text.slice(0, m.index).split("\n").length
      if (t.kind === "pkg")
        add(t.installedId, "css-import", site(rel, line, m[0]))
    }
  }

  for (const d of inventory.installed) {
    if (CONVENTION_FRAMEWORKS.has(d.name))
      add(
        d.id,
        "convention-framework",
        site(d.declaredBy[0]?.manifest ?? "package.json", 1, d.name)
      )
  }
  return hits
}

async function binNames(d: InstalledDep): Promise<string[]> {
  if (!d.dir) return [d.name.split("/").pop()!]
  try {
    const pj = JSON.parse(
      await readFile(join(d.dir, "package.json"), "utf8")
    ) as { name?: string; bin?: unknown }
    if (typeof pj.bin === "string")
      return [(pj.name ?? d.name).split("/").pop()!]
    if (pj.bin && typeof pj.bin === "object") return Object.keys(pj.bin)
  } catch {
    // unreadable manifest
  }
  return []
}

const DEP_BLOCKS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
  "name",
  "scripts",
  "pnpm",
  "workspaces",
  "catalog",
  "catalogs",
])

function collectStrings(
  v: unknown,
  out: string[],
  manifest: boolean,
  depth = 0
): void {
  if (depth > 20) return
  if (typeof v === "string") out.push(v)
  else if (Array.isArray(v))
    for (const x of v) collectStrings(x, out, manifest, depth + 1)
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (manifest && depth === 0 && DEP_BLOCKS.has(k)) continue
      collectStrings(x, out, manifest, depth + 1)
    }
  }
}

function lineOfString(text: string, value: string): number {
  const i = text.indexOf(JSON.stringify(value))
  return i < 0 ? 1 : text.slice(0, i).split("\n").length
}

function site(file: string, line: number, text: string): Site {
  return { file, line, col: 1, typeOnly: false, text }
}
