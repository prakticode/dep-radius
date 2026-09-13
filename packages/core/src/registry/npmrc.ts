import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, readFileSync } from "node:fs"

import { parseDuration } from "../options.ts"

export interface RegistryConfig {
  defaultRegistry: string
  scoped: Record<string, string>
  tokens: Record<string, string>
  minimumReleaseAgeMs?: number
  minimumReleaseAgeSource?: string
  minimumReleaseAgeExclude: string[]
}

function parseIni(
  text: string,
  env: NodeJS.ProcessEnv
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? "")
    out[key] = value
  }
  return out
}

export function loadRegistryConfig(
  root: string,
  env: NodeJS.ProcessEnv
): RegistryConfig {
  const merged: Record<string, string> = {}
  for (const file of [join(homedir(), ".npmrc"), join(root, ".npmrc")]) {
    if (existsSync(file))
      Object.assign(merged, parseIni(readFileSync(file, "utf8"), env))
  }
  const cfg: RegistryConfig = {
    defaultRegistry: trimSlash(
      env.npm_config_registry || merged.registry || "https://registry.npmjs.org"
    ),
    scoped: {},
    tokens: {},
    minimumReleaseAgeExclude: [],
  }
  for (const [k, v] of Object.entries(merged)) {
    const scope = /^(@[^:]+):registry$/.exec(k)
    if (scope?.[1]) cfg.scoped[scope[1]] = trimSlash(v)
    const token = /^\/\/(.+?)\/?:_authToken$/.exec(k)
    if (token?.[1] && v) cfg.tokens[token[1].replace(/\/$/, "")] = v
  }
  const npmrcAge = merged["minimum-release-age"]
  if (npmrcAge) {
    cfg.minimumReleaseAgeMs = parseDuration(npmrcAge)
    cfg.minimumReleaseAgeSource = ".npmrc minimum-release-age"
  }

  const ws = join(root, "pnpm-workspace.yaml")
  if (existsSync(ws)) {
    const text = readFileSync(ws, "utf8")
    const age = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(text)
    if (age?.[1]) {
      cfg.minimumReleaseAgeMs = Number(age[1]) * 60_000
      cfg.minimumReleaseAgeSource = "pnpm-workspace.yaml minimumReleaseAge"
    }
    const block = /^minimumReleaseAgeExclude:\s*\n((?:[ \t]+-.*\n?)*)/m.exec(
      text
    )
    for (const line of block?.[1]?.split("\n") ?? []) {
      const m = /^\s+-\s+['"]?([^'"\s]+)['"]?/.exec(line)
      if (m?.[1]) cfg.minimumReleaseAgeExclude.push(m[1])
    }
  }
  return cfg
}

export function registryFor(cfg: RegistryConfig, pkg: string): string {
  if (pkg.startsWith("@")) {
    const scope = pkg.split("/")[0]!
    if (cfg.scoped[scope]) return cfg.scoped[scope]
  }
  return cfg.defaultRegistry
}

export function authHeaders(
  cfg: RegistryConfig,
  url: string
): Record<string, string> {
  const host = url.replace(/^https?:\/\//, "")
  let best = ""
  for (const prefix of Object.keys(cfg.tokens)) {
    if (host.startsWith(prefix) && prefix.length > best.length) best = prefix
  }
  return best ? { authorization: `Bearer ${cfg.tokens[best]}` } : {}
}

// "lib", "lib@2.1.0" (only that version waived), "@scope/*"
export function isAgeExcluded(
  cfg: RegistryConfig,
  pkg: string,
  version: string
): boolean {
  return cfg.minimumReleaseAgeExclude.some((pattern) => {
    const at = pattern.lastIndexOf("@")
    const [name, ver] =
      at > 0
        ? [pattern.slice(0, at), pattern.slice(at + 1)]
        : [pattern, undefined]
    const nameOk = name.endsWith("*")
      ? pkg.startsWith(name.slice(0, -1))
      : pkg === name
    return (
      nameOk &&
      (ver === undefined || ver.split("||").some((v) => v.trim() === version))
    )
  })
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "")
}
