---
"dep-radius": patch
"@dep-radius/core": patch
---

A lockfile or `node_modules` that is out of date with `package.json` is no longer read as the
version you have. When a change bumps a version without updating the lockfile, `--since` used to
compare the old lockfile entry with itself and report nothing changed. radius now skips the stale
source, reads the next one, and says so with the new `out-of-sync` reason, which keeps the update
from being called quiet. Overrides, catalogs and peer ranges are not mistaken for a stale lockfile.
