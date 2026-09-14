# @dep-radius/core

## 0.3.0

### Minor Changes

- ebc5074: A release note about an option now lands on the calls that accept it, read from the
  package's types, even when the code never passes the option. "Default `quiet` to false"
  (dotenv 17) points at `dotenv.config()`, "changed `returnNull` default to `false`" (i18next 23) at
  `i18next.init()`, and "`Strict-Transport-Security` now has a max-age of 365 days" (helmet 8) at
  `helmet()`. These matches are marked "possibly", and the terminal and pull request comment say "an
  option of a call you make". In `--json`, such a name carries `option: true`.

## 0.2.3

### Patch Changes

- 861acc4: Release notes that start an entry with `*Breaking*` or `_Breaking_` are now read as
  breaking, like `**Breaking**` already was. Commander 13 writes its breaking changes this way: they
  were matched and sorted like ordinary notes, and "excess command-arguments cause an error by
  default", which names no API, was never reported as a breaking note that could apply to anyone.

## 0.2.2

### Patch Changes

- 8fd9fb0: A name missing from the new version's types is only called removed when radius could have
  seen it. When the new types re-export another package with `export *`, extend a class from an
  unloaded dependency, or stop at the symbol limit, the package now gets review with that reason
  instead of blocked. Names that moved under another alias (`z.object` behind `export default z`, a
  namespace member that became a named export) are followed instead of reported as removed.

## 0.2.1

### Patch Changes

- 4c5aa07: The npm pages link to the documentation at [depradius.com](https://depradius.com).

## 0.2.0

### Minor Changes

- 8d1b5b1: `radius --since <git-ref>` briefs the dependencies whose version changed between that
  commit and the working tree: the brief for a pull request, or for the upgrade you just ran. It
  needs no install, reads versions from the lockfile at the ref, and adds an optional `since` field
  to the `--json` output.

  Run from a package folder of a monorepo, radius now reads the lockfile at the repository root
  instead of guessing versions from the ranges.

## 0.1.0

### Minor Changes

- 2fec6a1: First release. `radius` reads a project as it is (any installer, one manifest or many,
  TypeScript or JavaScript), compares the type surface and the release notes of each available
  update with the code that uses the package, and says quiet, review or blocked. `--json` follows
  schema version 1, and `@dep-radius/core` exposes the same engine as a library.
