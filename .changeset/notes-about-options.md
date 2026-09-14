---
"@dep-radius/core": minor
"dep-radius": minor
---

A release note about an option now lands on the calls that accept it, read from the package's types,
even when the code never passes the option. "Default `quiet` to false" (dotenv 17) points at
`dotenv.config()`, "changed `returnNull` default to `false`" (i18next 23) at `i18next.init()`, and
"`Strict-Transport-Security` now has a max-age of 365 days" (helmet 8) at `helmet()`. These matches
are marked "possibly", and the terminal and pull request comment say "an option of a call you make".
In `--json`, such a name carries `option: true`.
