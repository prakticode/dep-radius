import semver from "semver"

import type { SpecKind } from "../model.ts"

export function classifySpec(spec: string): {
  kind: SpecKind
  aliasOf?: string
} {
  const s = spec.trim()
  if (s.startsWith("workspace:")) return { kind: "workspace" }
  if (s.startsWith("catalog:")) return { kind: "catalog" }
  if (s.startsWith("link:")) return { kind: "link" }
  if (
    s.startsWith("file:") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~/")
  )
    return { kind: "file" }
  if (s.startsWith("npm:")) {
    const rest = s.slice(4)
    const at = rest.lastIndexOf("@")
    return { kind: "alias", aliasOf: at > 0 ? rest.slice(0, at) : rest }
  }
  if (
    /^(git\+|git:|github:|gitlab:|bitbucket:)/.test(s) ||
    /^[\w-]+\/[\w.-]+(#.*)?$/.test(s)
  )
    return { kind: "git" }
  if (/^https?:/.test(s)) return { kind: "url" }
  if (s === "" || s === "*" || s === "latest" || semver.validRange(s)) {
    return { kind: s === "latest" ? "tag" : "range" }
  }
  if (/^[a-z][\w.-]*$/i.test(s)) return { kind: "tag" }
  return { kind: "range" }
}

// "lib/locales" -> lib ; "@scope/name/sub" -> @scope/name ; relative or node: -> undefined
export function packageNameOf(specifier: string): string | undefined {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  )
    return undefined
  if (/^[a-z]+:/i.test(specifier)) return undefined
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || !parts[1]) return undefined
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0]
}

export function subpathOf(specifier: string, pkg: string): string {
  const rest = specifier.slice(pkg.length)
  return rest ? `.${rest}` : "."
}
