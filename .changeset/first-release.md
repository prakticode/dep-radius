---
"@dep-radius/core": minor
"dep-radius": minor
---

First release. `radius` reads a project as it is (any installer, one manifest or many, TypeScript or
JavaScript), compares the type surface and the release notes of each available update with the code
that uses the package, and says quiet, review or blocked. `--json` follows schema version 1, and
`@dep-radius/core` exposes the same engine as a library.
