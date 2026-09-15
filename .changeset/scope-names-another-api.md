---
"dep-radius": patch
"@dep-radius/core": patch
---

A release note whose commit title names a scope and another API, such as
`fix(model): make Model.bulkWrite() not throw`, is no longer tied to every use of `model`. The scope
is the area the commit touched, not the change. On a mongoose 7 to 9 upgrade this cuts the notes
listed against a project from 97 to 13, with the breaking notes still first.
