import { join } from "node:path"

import { readJson, writeJson } from "./store.ts"
import type { TypesSource, Upgrade } from "./case.ts"

// The public npm registry and jsDelivr's file listing: neither spends the GitHub budget. Answers are
// kept under the data directory, keyed by name and version, since a published version never
// changes.

export interface VersionManifest {
  name?: string
  version?: string
  repository?: string | { url?: string; directory?: string }
  types?: string
  typings?: string
  exports?: unknown
  main?: string
}

export type Fetch = typeof fetch

function key(name: string, version: string): string {
  return `${name.replace("/", "__")}@${version}.json`
}

async function cachedJson<T>(
  file: string,
  url: string,
  fetchImpl: Fetch
): Promise<T | undefined> {
  const hit = readJson<{ body: T | null }>(file)
  if (hit) return hit.body ?? undefined
  const res = await fetchImpl(url, { headers: { accept: "application/json" } })
  if (res.status === 404) {
    writeJson(file, { body: null })
    return undefined
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const body = (await res.json()) as T
  writeJson(file, { body })
  return body
}

export class Npm {
  private readonly dir: string
  private readonly fetchImpl: Fetch

  constructor(data: string, fetchImpl: Fetch = fetch) {
    this.dir = join(data, "api", "npm")
    this.fetchImpl = fetchImpl
  }

  manifest(
    name: string,
    version: string
  ): Promise<VersionManifest | undefined> {
    return cachedJson(
      join(this.dir, "manifest", key(name, version)),
      `https://registry.npmjs.org/${name}/${version}`,
      this.fetchImpl
    )
  }

  async files(name: string, version: string): Promise<string[] | undefined> {
    const body = await cachedJson<{ files?: { name: string }[] }>(
      join(this.dir, "files", key(name, version)),
      `https://data.jsdelivr.com/v1/packages/npm/${name}@${version}?structure=flat`,
      this.fetchImpl
    )
    return body?.files?.map((f) => f.name)
  }
}

// `git+https://github.com/getsentry/sentry-javascript.git` and its variants, as one comparable key.
export function repositoryKey(
  repository: VersionManifest["repository"]
): string | undefined {
  const url = typeof repository === "string" ? repository : repository?.url
  if (!url) return undefined
  const m =
    /github(?:\.com)?[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[#?/].*)?$/i.exec(
      url
    ) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(url)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : url.toLowerCase()
}

function exportsHaveTypes(exports: unknown): boolean {
  if (!exports || typeof exports !== "object") return false
  return Object.entries(exports).some(
    ([k, v]) =>
      k === "types" ||
      (typeof v === "string" && /\.d\.[cm]?ts$/.test(v)) ||
      exportsHaveTypes(v)
  )
}

// Where the types a TypeScript user gets for the new version come from. `hasAtTypes` says whether
// the project also installs `@types/<name>`.
export async function typesSource(
  npm: Npm,
  upgrade: Upgrade,
  hasAtTypes: boolean
): Promise<TypesSource> {
  if (upgrade.name.startsWith("@types/")) return "bundled"
  try {
    const m = await npm.manifest(upgrade.name, upgrade.to)
    if (!m) return "unknown"
    if (m.types || m.typings || exportsHaveTypes(m.exports)) return "bundled"
    const files = await npm.files(upgrade.name, upgrade.to)
    if (files?.some((f) => /\.d\.[cm]?ts$/.test(f))) return "bundled"
    if (hasAtTypes) return "@types"
    return files ? "none" : "unknown"
  } catch {
    return "unknown"
  }
}

export function atTypesName(pkg: string): string {
  return `@types/${pkg.startsWith("@") ? pkg.slice(1).replace("/", "__") : pkg}`
}
