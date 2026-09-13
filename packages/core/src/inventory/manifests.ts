import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import { classifySpec } from "./specifiers.ts"
import type { DeclaredDep, DepField, Manifest } from "../model.ts"

const run = promisify(execFile)

// Folders that hold output or third party code, never a manifest someone wrote.
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  ".parcel-cache",
  ".yarn",
  "dist",
  "build",
  "out",
  "coverage",
  "bower_components",
  "jspm_packages",
])

const FIELDS: DepField[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]

export async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      {
        cwd: root,
        maxBuffer: 256 * 1024 * 1024,
      }
    )
    return stdout.split("\0").filter(Boolean)
  } catch {
    return undefined
  }
}

export async function walkFiles(
  root: string,
  accept: (rel: string) => boolean,
  limit = 200_000
): Promise<string[]> {
  const out: string[] = []
  const stack = [""]
  while (stack.length > 0 && out.length < limit) {
    const rel = stack.pop()!
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(childRel)
      } else if (e.isFile() && accept(childRel)) {
        out.push(childRel)
      }
    }
  }
  return out.sort()
}

export async function listProjectFiles(root: string): Promise<string[]> {
  const git = await gitFiles(root)
  if (git)
    return git
      .filter((f) => !f.split("/").some((seg) => seg === "node_modules"))
      .sort()
  return walkFiles(root, () => true)
}

export async function findManifests(
  root: string,
  files: string[]
): Promise<Manifest[]> {
  const paths = files.filter(
    (f) => f === "package.json" || f.endsWith("/package.json")
  )
  const manifests: Manifest[] = []
  for (const rel of paths) {
    const abs = join(root, rel)
    let json: Record<string, unknown>
    try {
      json = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>
    } catch {
      continue
    }
    manifests.push(toManifest(abs, json))
  }
  return manifests
}

export function toManifest(
  abs: string,
  json: Record<string, unknown>
): Manifest {
  const deps: DeclaredDep[] = []
  for (const field of FIELDS) {
    const block = json[field]
    if (!block || typeof block !== "object") continue
    for (const [key, spec] of Object.entries(
      block as Record<string, unknown>
    )) {
      if (typeof spec !== "string") continue
      const c = classifySpec(spec)
      deps.push({
        key,
        spec,
        field,
        specKind: c.kind,
        ...(c.aliasOf ? { aliasOf: c.aliasOf } : {}),
      })
    }
  }
  return {
    path: abs,
    dir: dirname(abs),
    name: typeof json.name === "string" ? json.name : undefined,
    private: json.private === true,
    deps,
    scripts: (json.scripts && typeof json.scripts === "object"
      ? json.scripts
      : {}) as Record<string, string>,
    exports: json.exports,
    main: typeof json.main === "string" ? json.main : undefined,
    module: typeof json.module === "string" ? json.module : undefined,
    types:
      typeof json.types === "string"
        ? json.types
        : typeof json.typings === "string"
          ? json.typings
          : undefined,
  }
}

export function relPath(root: string, abs: string): string {
  const r = relative(root, abs)
  return (r || ".").split(sep).join("/")
}
