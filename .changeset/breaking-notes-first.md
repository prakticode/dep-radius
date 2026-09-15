---
"dep-radius": patch
"@dep-radius/core": patch
---

A release note marked breaking that names something your code uses is now listed before the ordinary
fixes that name it exactly, in the terminal, the pull request comment and `--json`. On a long
upgrade such as mongoose 7 to 9, dozens of exact fixes no longer push the breaking note out of the
default output.
