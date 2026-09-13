---
"dep-radius": patch
"@dep-radius/core": patch
---

A name missing from the new version's types is only called removed when radius could have seen it.
When the new types re-export another package with `export *`, extend a class from an unloaded
dependency, or stop at the symbol limit, the package now gets review with that reason instead of
blocked. Names that moved under another alias (`z.object` behind `export default z`, a namespace
member that became a named export) are followed instead of reported as removed.
