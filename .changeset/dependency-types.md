---
"@dep-radius/core": patch
"dep-radius": patch
---

radius now reads the types a package takes from its own dependencies. `useQuery` in
`@tanstack/react-query` accepts options declared in `@tanstack/query-core`: those options were
invisible, so a release note about one could not reach your `useQuery` calls. When it reads a
package version's types, radius also loads the declarations of the dependencies and peer
dependencies they import, one level down, at the version the package's range picks, from the same
registry and cache. A few packages and a few megabytes at most; dependencies without types are
skipped. Offline, what is cached is used, and a type surface missing a dependency that could not be
fetched is not kept, so the next run completes it.
