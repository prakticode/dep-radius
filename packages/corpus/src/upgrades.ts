import semver from "semver"

import {
  buildInventory,
  listProjectFiles,
  planSince,
  readBaseTree,
} from "@dep-radius/core/debug"

import type { Upgrade } from "./case.ts"
import { type Repo, VERSION_FILE } from "./git.ts"

// The direct dependencies whose locked version went up between two commits, paired exactly as
// `radius --since` pairs them: the packages a case lists are the ones evaluation analyses.
export async function upgradesBetween(
  repo: Repo,
  base: string,
  upgraded: string
): Promise<Upgrade[]> {
  await repo.prefetch(base, (p) => VERSION_FILE.test(p))
  await repo.prefetch(upgraded, (p) => VERSION_FILE.test(p))
  const [before, after] = await Promise.all([
    readBaseTree(repo.dir, base),
    readBaseTree(repo.dir, upgraded),
  ])
  try {
    const [b, a] = await Promise.all([
      buildInventory(
        before.dir,
        { prod: false },
        await listProjectFiles(before.dir)
      ),
      buildInventory(
        after.dir,
        { prod: false },
        await listProjectFiles(after.dir)
      ),
    ])
    const plan = planSince(a.installed, b, base)
    const out = new Map<string, Upgrade>()
    for (const c of plan.changed) {
      const from = c.dep.version
      if (!semver.valid(from) || !semver.valid(c.to) || !semver.gt(c.to, from))
        continue
      out.set(c.dep.name, { name: c.dep.name, from, to: c.to })
    }
    return [...out.values()].sort((x, y) => x.name.localeCompare(y.name))
  } finally {
    await Promise.all([before.cleanup(), after.cleanup()])
  }
}
