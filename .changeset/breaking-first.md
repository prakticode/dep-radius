---
"@dep-radius/core": patch
"dep-radius": patch
---

Each package in the terminal report and the pull request comment now starts with what breaks and is
tied to your code: removed exports and breaking notes naming what you use, then changed signatures
and notes naming what you use, then breaking notes that are only possibly about you or name no API,
and last the changes matched by member name and the other possible notes. Type changes used to come
first whatever their certainty, so a change matched by member name could sit above a breaking note
that named the line. Nothing is hidden, and `--json` is unchanged. `@dep-radius/core/render` exports
`orderFindings` for renderers of your own.
