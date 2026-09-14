---
"@dep-radius/core": patch
"dep-radius": patch
---

Three kinds of release notes that could leave an update quiet now reach the code they describe.
Without type declarations, the keys the code passes to a call count as its options, so "improve
`limit` option validation" (body-parser 2.3) lands on `bodyParser.json({ limit })`. A code span
naming a nested option, like `retry.methods` (ky), matches the option. And a commit title that
starts with an API, like `diff: fix prerelease to stable version diff logic` (semver 7.7), names
that API.
