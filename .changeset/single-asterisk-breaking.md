---
"@dep-radius/core": patch
"dep-radius": patch
---

Release notes that start an entry with `*Breaking*` or `_Breaking_` are now read as breaking, like
`**Breaking**` already was. Commander 13 writes its breaking changes this way: they were matched and
sorted like ordinary notes, and "excess command-arguments cause an error by default", which names no
API, was never reported as a breaking note that could apply to anyone.
