# dep-radius

## 0.2.0

### Minor Changes

- 8d1b5b1: `radius --since <git-ref>` briefs the dependencies whose version changed between that
  commit and the working tree: the brief for a pull request, or for the upgrade you just ran. It
  needs no install, reads versions from the lockfile at the ref, and adds an optional `since` field
  to the `--json` output.

  Run from a package folder of a monorepo, radius now reads the lockfile at the repository root
  instead of guessing versions from the ranges.

### Patch Changes

- Updated dependencies [8d1b5b1]
  - @dep-radius/core@0.2.0

## 0.1.0

### Minor Changes

- 2fec6a1: First release. `radius` reads a project as it is (any installer, one manifest or many,
  TypeScript or JavaScript), compares the type surface and the release notes of each available
  update with the code that uses the package, and says quiet, review or blocked. `--json` follows
  schema version 1, and `@dep-radius/core` exposes the same engine as a library.

### Patch Changes

- Updated dependencies [2fec6a1]
  - @dep-radius/core@0.1.0
