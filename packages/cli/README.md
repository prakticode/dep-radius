# dep-radius

[![npm](https://img.shields.io/npm/v/dep-radius)](https://www.npmjs.com/package/dep-radius)
[![CI](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml/badge.svg)](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dep-radius)](LICENSE)

Which changes in a dependency update land on code you actually wrote. Documentation:
[depradius.com](https://depradius.com).

```sh
npx dep-radius                 # every direct dependency with an update waiting
npx dep-radius schemakit       # one package
npx dep-radius schemakit@3.2.0 # an exact target
npx dep-radius --since main    # the dependencies whose version changed since that commit
```

```
◇  Read 412 files
◇  Checked 38 packages in 9.4s

schemakit  3.1.4 → 3.2.0  minor  published 3d ago   REVIEW
  surface changes ......... 12
  changes you touch ....... 0
  notes mentioning you .... 1  of 18, notes for 1/1 versions (github-release)

  3.2.0  ⚠️ The email pattern no longer accepts quoted local parts
    you use: email
    src/signup/schema.ts:14
    src/billing/contact.ts:9  (via src/lib/validation.ts)

...

38 with an update  31 quiet · 7 review · 0 blocked  · 12 up to date
```

No account, no configuration file, no build. It reads the folder as it is: any installer, one
manifest or fifty, TypeScript or plain JavaScript.

## How it decides

Two nets, counted apart and never merged into one reassuring number:

1. **The type surface.** Both versions' declaration files are compared, and every changed or removed
   export is matched against the names your code resolves into the package, through local re-export
   files and values built in other files.
2. **The release notes.** GitHub releases or the changelog, split into entries, kept only when they
   name something you use.

| Verdict | Exit | Means                                                                           |
| ------- | ---- | ------------------------------------------------------------------------------- |
| quiet   | 0    | nothing you use changed, and every note is accounted for: merge without reading |
| review  | 1    | here are the lines concerned, or here is what the tool could not see            |
| blocked | 2    | an export you call was removed                                                  |

Anything the tool cannot see pushes towards review, never towards quiet: packages used only from
scripts, config strings or CSS, names passed around whole, packages with neither types nor notes. A
quiet verdict that stood on one net only is marked `*`.

## Options

`--json`, `--markdown` (a pull request comment), `--since <git-ref>` (compare with a commit, reading
its lockfile, nothing installed), `--offline`, `--min-age <duration>` (default 1d, or the project's
`minimumReleaseAge`), `--latest`, `--no-notes`, `--no-surface`, `--prod`, `--verbose`. Set
`GITHUB_TOKEN`, or log in with `gh`, to lift GitHub's limit from 60 to 5000 requests an hour.

`--json` is a stable contract, `schemaVersion: 1`, described by
[`brief-v1.schema.json`](../core/schema/brief-v1.schema.json), shipped in `@dep-radius/core` as
`@dep-radius/core/schema/brief-v1.schema.json`. Version 1 only ever gains fields; removing or
renaming one means version 2.

Everything downloaded is cached: a second run is offline and takes about as long as reading your
files. Type surfaces are keyed by tarball integrity, so they are the same for everyone.

## Limits

- Behaviour changes are only seen through release notes.
- No type checker runs over your code: a member reached through a callback or a value from an
  unfollowed place is matched by name only.
- A package whose declarations re-export another package's types is judged from its notes only.
- Release notes are read from GitHub and the package's own changelog.
- Transitive dependencies are out of scope; a lockfile and an install cooldown own that risk.
