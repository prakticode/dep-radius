---
"dep-radius": patch
"@dep-radius/core": patch
---

radius now follows values declared with a package's type, such as `ctx` in
`function load(ctx: Context) { ctx.store.list({ limit }) }`: the reads and the options passed on
them count as usage, so a note about `limit` lands on that call and on the line of the option
instead of leaving the upgrade quiet.
