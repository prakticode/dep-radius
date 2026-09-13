---
"@dep-radius/core": minor
"dep-radius": minor
---

`radius --since <git-ref>` briefs the dependencies whose version changed between that commit and the
working tree: the brief for a pull request, or for the upgrade you just ran. It needs no install,
reads versions from the lockfile at the ref, and adds an optional `since` field to the `--json`
output.

Run from a package folder of a monorepo, radius now reads the lockfile at the repository root
instead of guessing versions from the ranges.
