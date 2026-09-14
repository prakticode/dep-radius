# dep-radius

[![npm](https://img.shields.io/npm/v/dep-radius)](https://www.npmjs.com/package/dep-radius)
[![CI](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml/badge.svg)](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dep-radius)](LICENSE)

Tells your AI agent which changes in a dependency upgrade affect your code, with the files and lines
to check. No AI inside, and your code stays on your machine. Docs and the agent guide:
[depradius.com](https://depradius.com).

```sh
npx dep-radius --since HEAD --json  # after an upgrade, for an AI agent
npx dep-radius                 # every direct dependency with an update waiting
npx dep-radius schemakit       # one package
npx dep-radius schemakit@3.2.0 # an exact target
npx dep-radius --since main    # the dependencies whose version changed since that commit
```

```
zod  4.4.3 → 4.5.0  minor   REVIEW
  notes mentioning you .... 4  (+1 possibly)  of 29, notes for 1/1 versions (github-release)
  used in 1 file, 3 sites · package.json

  4.5.0  ⚠️ String length counts code points
    you use: string, max, min
    src/feedback/schema.ts:5  (via src/lib/zod.ts)
  ...
  4.5.0  Zod 4.5 is now available.  cannot tie to your code
  ... 20 more changes radius cannot tie to your code (--verbose)

  why: 5 release notes mention names you use (4 by name in the text)
  why: 23 release notes describe changes radius cannot tie to your code
```

No account, no config file, no build. Works with any package manager, one `package.json` or many,
TypeScript or JavaScript.

## How it decides

radius runs two separate checks:

1. **The types.** It compares the type files of both versions, and finds which changed or removed
   functions your code uses, even through your own re-export files.
2. **The release notes.** It splits them into entries. An entry that names something you use is
   shown with your lines. An entry that describes a change radius can't link to your code is listed,
   and the update can't be quiet.

| Answer  | Exit | Means                                                     |
| ------- | ---- | --------------------------------------------------------- |
| quiet   | 0    | nothing your code uses changed: you can merge             |
| review  | 1    | here are the lines to check, or what radius could not see |
| blocked | 2    | something your code calls was removed                     |

When radius can't see how a package is used, it says review, never quiet. For example: a package
used only from scripts, config files or CSS, or passed around whole. A quiet that relied on only one
of the two checks is marked `*`.

## Options

`--json`, `--markdown` (a pull request comment), `--since <git-ref>` (compare with a commit, reading
its lockfile, nothing installed), `--offline`, `--min-age <duration>` (default 1d, or the project's
`minimumReleaseAge`), `--latest`, `--no-notes`, `--no-surface`, `--prod`, `--verbose`. Set
`GITHUB_TOKEN`, or log in with `gh`, to lift GitHub's limit from 60 to 5000 requests an hour.

The `--json` output has a version, `schemaVersion: 1`, described by
[`brief-v1.schema.json`](../core/schema/brief-v1.schema.json) (also shipped as
`@dep-radius/core/schema/brief-v1.schema.json`). Version 1 only adds fields. Removing or renaming
one would mean version 2.

Everything downloaded is cached, so a second run is fast and can work offline.

## Limits

- radius only knows what the release notes say.
- It doesn't type-check your code: a member used through a callback, or through a value radius
  didn't follow, is matched by name only.
- A package whose types come from another package is judged from its notes only.
- Release notes come from GitHub and the package's own changelog.
- Dependencies of your dependencies aren't checked. Your lockfile handles that.
