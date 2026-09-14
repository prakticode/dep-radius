---
"@dep-radius/core": patch
"dep-radius": patch
---

The list of release notes radius cannot tie to your code is shorter and cleaner. A release's opening
sentence ("Zod 4.5 is now available."), pointers to a migration guide, work on the project itself
(tests, CI, linting, spelling, readme, dev dependencies, thanks), and changes to TypeScript typings
only are no longer listed. A labelled list like "breaking:" or "**resolve**:" is split into its
items, so each change is judged on its own and a breaking label still marks its items.

A breaking section that only mentions a few APIs in its text now stays a break that could apply to
anyone, instead of being read as someone else's.
