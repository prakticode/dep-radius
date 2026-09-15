---
"dep-radius": patch
"@dep-radius/core": patch
---

A breaking note that sends the reader to a section of its release, such as "excess arguments cause
an error by default, see migration tips", is now read with that section, so the names in its
examples tie the note to your code. Reads on a value declared with a package's type, such as
`cmd.args` in `(cmd: Command) => cmd.args`, now count as exact, like reads on the import.
