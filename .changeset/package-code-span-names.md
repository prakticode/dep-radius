---
"dep-radius": patch
"@dep-radius/core": patch
---

A release note that names a package in a code span, such as "[breaking] `linkify-it` => v6", now
ties to the member of your code named after it, such as `md.linkify`, as a possible match. Before,
markdown-it 15's change to linkify defaults was listed as a change radius could not tie to your
code.
