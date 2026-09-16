---
"dep-radius": patch
"@dep-radius/core": patch
---

A signature change that only touches optional parameters no longer flags the calls that stop before
them. When an options object gains a property, `create()` with no arguments sees the same function
and is left out, while `create({ name })` is still shown. The type parameters, the return type and
the number of parameters must stay the same; a spread argument always counts.
