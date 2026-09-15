# dep-radius

## 0.4.6

### Patch Changes

- d8534a7: A lockfile or `node_modules` that is out of date with `package.json` is no longer read as
  the version you have. When a change bumps a version without updating the lockfile, `--since` used
  to compare the old lockfile entry with itself and report nothing changed. radius now skips the
  stale source, reads the next one, and says so with the new `out-of-sync` reason, which keeps the
  update from being called quiet. Overrides, catalogs and peer ranges are not mistaken for a stale
  lockfile.
- Updated dependencies [d8534a7]
  - @dep-radius/core@0.4.6

## 0.4.5

### Patch Changes

- e95ec13: A release note marked breaking that names something your code uses is now listed before
  the ordinary fixes that name it exactly, in the terminal, the pull request comment and `--json`.
  On a long upgrade such as mongoose 7 to 9, dozens of exact fixes no longer push the breaking note
  out of the default output.
- Updated dependencies [e95ec13]
  - @dep-radius/core@0.4.5

## 0.4.4

### Patch Changes

- 36a2123: A release note about an option now lands on the line that writes the option as well as on
  the call that passes it, so `ssl: true` inside a `new Pool({ ... })` spread over several lines is
  shown on its own line.
- 52229bd: radius now follows values declared with a package's type, such as `ctx` in
  `function load(ctx: Context) { ctx.store.list({ limit }) }`: the reads and the options passed on
  them count as usage, so a note about `limit` lands on that call and on the line of the option
  instead of leaving the upgrade quiet.
- Updated dependencies [36a2123]
- Updated dependencies [52229bd]
  - @dep-radius/core@0.4.4

## 0.4.3

### Patch Changes

- 60aadbd: A release note radius cannot tie to your code by name can now show where it probably
  lands: when the note names a function inside the package that changed under an export you use,
  such as `setItem` called by `persist`, the brief adds "probably reaches" with your sites, and
  `--json` adds `likely` to the entry. It is a hint only: verdicts do not change, and it is left out
  when most of the package's code changed.
- Updated dependencies [60aadbd]
  - @dep-radius/core@0.4.3

## 0.4.2

### Patch Changes

- 009304a: A release note about an option now also lands on the classes you construct with it:
  `new Ajv({ strict })` or `new XMLParser({ ... })` accept the options their constructor declares,
  inherited constructors and `export =` classes included, the same way `config({ quiet })` already
  did for functions. Options types written as an intersection (`CurrentOptions & DeprecatedOptions`)
  are read too. A method called on the constructed object (`new Parser().parse()`) is now found in
  the types as well.

  Options one level down count too: a note about `eNotation` lands on `new XMLParser({ ... })`,
  whose options take `numberParseOptions: { eNotation }`.

- e7a2617: radius now reads the types a package takes from its own dependencies. `useQuery` in
  `@tanstack/react-query` accepts options declared in `@tanstack/query-core`: those options were
  invisible, so a release note about one could not reach your `useQuery` calls. When it reads a
  package version's types, radius also loads the declarations of the dependencies and peer
  dependencies they import, one level down, at the version the package's range picks, from the same
  registry and cache. A few packages and a few megabytes at most; dependencies without types are
  skipped. Offline, what is cached is used, and a type surface missing a dependency that could not
  be fetched is not kept, so the next run completes it.
- cba6aa8: The list of release notes radius cannot tie to your code is shorter and cleaner. A
  release's opening sentence ("Zod 4.5 is now available."), pointers to a migration guide, work on
  the project itself (tests, CI, linting, spelling, readme, dev dependencies, thanks), and changes
  to TypeScript typings only are no longer listed. A labelled list like "breaking:" or
  "**resolve**:" is split into its items, so each change is judged on its own and a breaking label
  still marks its items.

  A breaking section that only mentions a few APIs in its text now stays a break that could apply to
  anyone, instead of being read as someone else's.

- Updated dependencies [009304a]
- Updated dependencies [e7a2617]
- Updated dependencies [cba6aa8]
  - @dep-radius/core@0.4.2

## 0.4.1

### Patch Changes

- 6023f51: The package descriptions, keywords and READMEs now describe radius as it is used: it
  tells an AI agent which changes in a dependency upgrade affect the code, with the files and lines
  to check.
- Updated dependencies [6023f51]
  - @dep-radius/core@0.4.1

## 0.4.0

### Minor Changes

- a4c0ae8: An update is no longer quiet while one of its release notes describes a change radius
  cannot tie to your code: a fix or a change that names no API ("Remove empty non-boolean
  attributes"), or names one radius cannot place because the package has no types. Such an update
  goes to review with the reason `unattributed-change`, and the notes are listed, so there are a few
  lines to read instead of a changelog. Housekeeping (docs, tests, CI, dependency updates, thanks,
  bare links) and additions (new features, options, speed-ups) do not count.

  Expect far fewer quiet verdicts: on 451 past upgrades of umami, uptime-kuma and outline, quiet
  went from 180 (40%) to 43 (10%), and no upgrade became quiet that was not before. In exchange,
  radius stops calling quiet the documented behaviour changes it could not connect to the code, 13
  of the 51 in its benchmark.

  `--json` gains `notes.changesWithoutApi`.

### Patch Changes

- Updated dependencies [a4c0ae8]
  - @dep-radius/core@0.4.0

## 0.3.2

### Patch Changes

- 854f2ea: Three kinds of release notes that could leave an update quiet now reach the code they
  describe. Without type declarations, the keys the code passes to a call count as its options, so
  "improve `limit` option validation" (body-parser 2.3) lands on `bodyParser.json({ limit })`. A
  code span naming a nested option, like `retry.methods` (ky), matches the option. And a commit
  title that starts with an API, like `diff: fix prerelease to stable version diff logic` (semver
  7.7), names that API.
- Updated dependencies [854f2ea]
  - @dep-radius/core@0.3.2

## 0.3.1

### Patch Changes

- 3327734: Each package in the terminal report and the pull request comment now starts with what
  breaks and is tied to your code: removed exports and breaking notes naming what you use, then
  changed signatures and notes naming what you use, then breaking notes that are only possibly about
  you or name no API, and last the changes matched by member name and the other possible notes. Type
  changes used to come first whatever their certainty, so a change matched by member name could sit
  above a breaking note that named the line. Nothing is hidden, and `--json` is unchanged.
  `@dep-radius/core/render` exports `orderFindings` for renderers of your own.
- Updated dependencies [3327734]
  - @dep-radius/core@0.3.1

## 0.3.0

### Minor Changes

- ebc5074: A release note about an option now lands on the calls that accept it, read from the
  package's types, even when the code never passes the option. "Default `quiet` to false"
  (dotenv 17) points at `dotenv.config()`, "changed `returnNull` default to `false`" (i18next 23) at
  `i18next.init()`, and "`Strict-Transport-Security` now has a max-age of 365 days" (helmet 8) at
  `helmet()`. These matches are marked "possibly", and the terminal and pull request comment say "an
  option of a call you make". In `--json`, such a name carries `option: true`.

### Patch Changes

- Updated dependencies [ebc5074]
  - @dep-radius/core@0.3.0

## 0.2.3

### Patch Changes

- 861acc4: Release notes that start an entry with `*Breaking*` or `_Breaking_` are now read as
  breaking, like `**Breaking**` already was. Commander 13 writes its breaking changes this way: they
  were matched and sorted like ordinary notes, and "excess command-arguments cause an error by
  default", which names no API, was never reported as a breaking note that could apply to anyone.
- Updated dependencies [861acc4]
  - @dep-radius/core@0.2.3

## 0.2.2

### Patch Changes

- 8fd9fb0: A name missing from the new version's types is only called removed when radius could have
  seen it. When the new types re-export another package with `export *`, extend a class from an
  unloaded dependency, or stop at the symbol limit, the package now gets review with that reason
  instead of blocked. Names that moved under another alias (`z.object` behind `export default z`, a
  namespace member that became a named export) are followed instead of reported as removed.
- Updated dependencies [8fd9fb0]
  - @dep-radius/core@0.2.2

## 0.2.1

### Patch Changes

- 4c5aa07: The npm pages link to the documentation at [depradius.com](https://depradius.com).
- Updated dependencies [4c5aa07]
  - @dep-radius/core@0.2.1

## 0.2.0

### Minor Changes

- 8d1b5b1: `radius --since <git-ref>` briefs the dependencies whose version changed between that
  commit and the working tree: the brief for a pull request, or for the upgrade you just ran. It
  needs no install, reads versions from the lockfile at the ref, and adds an optional `since` field
  to the `--json` output.

  Run from a package folder of a monorepo, radius now reads the lockfile at the repository root
  instead of guessing versions from the ranges.

### Patch Changes

- Updated dependencies [8d1b5b1]
  - @dep-radius/core@0.2.0

## 0.1.0

### Minor Changes

- 2fec6a1: First release. `radius` reads a project as it is (any installer, one manifest or many,
  TypeScript or JavaScript), compares the type surface and the release notes of each available
  update with the code that uses the package, and says quiet, review or blocked. `--json` follows
  schema version 1, and `@dep-radius/core` exposes the same engine as a library.

### Patch Changes

- Updated dependencies [2fec6a1]
  - @dep-radius/core@0.1.0
