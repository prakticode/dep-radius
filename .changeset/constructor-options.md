---
"@dep-radius/core": patch
"dep-radius": patch
---

A release note about an option now also lands on the classes you construct with it:
`new Ajv({ strict })` or `new XMLParser({ ... })` accept the options their constructor declares,
inherited constructors and `export =` classes included, the same way `config({ quiet })` already did
for functions. Options types written as an intersection (`CurrentOptions & DeprecatedOptions`) are
read too. A method called on the constructed object (`new Parser().parse()`) is now found in the
types as well.
