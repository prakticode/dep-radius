---
"dep-radius": patch
"@dep-radius/core": patch
---

A folder installed on its own, such as a `functions/` folder with its own `package.json`, is no
longer read with the versions of the project around it. radius reads each manifest's nearest
lockfile, stops looking in `node_modules` at that lockfile's folder, and ignores a root lockfile
that has no entry for the folder. Before, bumping a dependency at the root reported the change
against the nested folder's code too, and a change in one nested install could hide behind another
install already on that version.
