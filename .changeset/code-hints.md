---
"dep-radius": patch
"@dep-radius/core": patch
---

A release note radius cannot tie to your code by name can now show where it probably lands: when the
note names a function inside the package that changed under an export you use, such as `setItem`
called by `persist`, the brief adds "probably reaches" with your sites, and `--json` adds `likely`
to the entry. It is a hint only: verdicts do not change, and it is left out when most of the
package's code changed.
