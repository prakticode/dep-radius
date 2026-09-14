import type { Upgrade } from "./case.ts"

// The upgrades of a pull request as releases: the packages of one monorepo (`@sentry/*` from
// getsentry/sentry-javascript) ship together and make one release. A case spanning several
// unrelated releases spreads its expected lines over every package a file imports, and the fix
// cannot say which one broke what.
//
// Packages share a release when their registry manifests name the same repository. Without one, the
// scope and the new version stand in: `@nx/js` and `@nx/devkit` at 23.2.0.
export function releaseGroups(
  upgrades: Upgrade[],
  repositories: Map<string, string | undefined>
): string[][] {
  const groups = new Map<string, string[]>()
  for (const u of upgrades) {
    const repo = repositories.get(u.name)
    const scope = u.name.startsWith("@") ? u.name.split("/")[0] : undefined
    const key = repo
      ? `repo:${repo}`
      : scope
        ? `scope:${scope}@${u.to}`
        : `name:${u.name}`
    groups.set(key, [...(groups.get(key) ?? []), u.name])
  }
  return [...groups.values()]
}
