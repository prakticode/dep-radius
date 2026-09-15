---
"dep-radius": patch
"@dep-radius/core": patch
---

A breaking release note that names no API but says what went, such as "Remove Deprecated Legacy
Namespace Support", is now shown at the lines of the removed exports your code uses, when the type
definitions confirm it: the old version exported a namespace that the new one no longer does, or
marked the removed exports as deprecated. Before, the note was listed apart as a break that could
apply to anyone, next to removed exports it explained.
