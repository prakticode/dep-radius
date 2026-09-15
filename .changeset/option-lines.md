---
"dep-radius": patch
"@dep-radius/core": patch
---

A release note about an option now lands on the line that writes the option as well as on the call
that passes it, so `ssl: true` inside a `new Pool({ ... })` spread over several lines is shown on
its own line.
