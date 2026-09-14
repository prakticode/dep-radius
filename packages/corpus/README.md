# @dep-radius/corpus

Collects real upgrade cases from GitHub and measures radius on them. Private, never published.

The source is the bot pull request a person had to fix: Renovate upgrades a package, and before
merging, someone pushes a commit on the bot's branch. That commit shows the lines the upgrade broke,
written by the project's own maintainer.

```sh
pnpm corpus:mine --limit 40     # find cases
pnpm corpus:check               # label them, flag the ones a person should read
pnpm corpus:evaluate            # run radius on the supported ones, print the score
pnpm corpus --help
```

`pnpm corpus` builds `@dep-radius/core` first, then runs `node packages/corpus/src/cli.ts`.

## Working and locked cases

Every case belongs to one of two sets, decided by a hash of its repository and pull request number:
about 80% are **working** cases, 20% are **locked**. The set never changes and is recorded in the
manifest as `split`.

- Working cases are for improving radius: read their results, their briefs, their review.
- Locked cases say whether an improvement generalises. `evaluate` prints their totals only, and
  writes their per-case results and briefs under `locked/`. **Do not read `locked/` while working on
  radius**, and do not tune anything against a locked case: a score on cases that shaped the code
  measures nothing.

## Commands

### `mine`

Searches merged pull requests by `renovate[bot]` in public JavaScript and TypeScript repositories,
merge day by merge day, newest first. The searches look for Renovate's two single-release titles,
"update dependency ..." and "update ... monorepo ...". GitHub's search ignores punctuation and
negated phrases (`"(major)"` also matches "non-major"), so titles of grouped updates ("all non-major
dependencies", "lock file maintenance") are skipped by the tool itself. A day holding more than
GitHub's 1000 results per search is searched in halves, down to an hour. `--dependabot` adds
Dependabot's pull requests: in a first run, none of about a hundred carried a commit by a person.

A pull request is a **candidate** when a commit on it was written by a person (not a bot, not a
merge). For each candidate:

1. **Commits.** `base` is the parent of the first commit. `upgraded` is the commit just before the
   first human one: upgraded, not yet fixed. The fix runs from there to the last human commit before
   any merge commit, since a merge brings the base branch's own changes.
2. **Packages.** The direct dependencies whose locked version went up from `base` to `upgraded`,
   read with core's inventory and paired the way `radius --since` pairs them. They must form at most
   `--max-packages` releases (default 1). A release is one package, or the packages one repository
   publishes together: `@sentry/node` and `@sentry/react` whose npm manifests both name
   getsentry/sentry-javascript. Without a repository, the scope and the new version stand in. A
   grouped upgrade spreads its expected lines over every package a file imports, and the fix cannot
   say which package broke which line.
3. **Expected lines.** `git diff -U0 upgraded..fixEnd` on source files: JavaScript and TypeScript in
   every variant, Vue, Svelte and Astro. A removed or rewritten line is expected when its file
   imports an upgraded package. Blank lines, comments and punctuation-only lines are left out.
4. **Layout.** A removed line only changed layout when the fix writes it again but for whitespace,
   quote style, semicolons, commas or parentheses around a lone arrow parameter, anywhere in the
   file (a moved line, reordered imports), or when a run of removed lines joins into the text the
   file gains (a call wrapped or unwrapped).

A candidate is rejected, with the reason recorded, when:

| Reason                                        | Meaning                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `first commit is not by a bot`                | A person opened the branch                                 |
| `merge commit before the fix`                 | The upgraded snapshot mixes in the base branch             |
| `git fetch failed`                            | The repository or the commits are gone                     |
| `could not read the lockfiles`                | No lockfile core can read at one of the commits            |
| `no dependency upgraded`                      | No locked direct dependency version went up                |
| `several releases upgraded`                   | More than `--max-packages` releases                        |
| `fix changes no source file`                  | Only lockfiles, configs or docs changed                    |
| `fix only adds lines`                         | Nothing existing was removed or rewritten                  |
| `no changed file imports an upgraded package` | The fix is in code that does not use the packages          |
| `fix too large`                               | More than `--max-lines` expected lines: a reformat or more |
| `fix is mostly a reformat`                    | Half or more of the removed source lines only moved layout |

The clone of a rejected candidate is deleted unless a kept case shares its repository.

Options: `--limit <n>` candidates per run (default 40), `--since <date>` and `--until <date>` merge
days (default the last 90 days, ending yesterday), `--query <q>` to replace the searches
(repeatable, the merge window is appended), `--dependabot`, `--max-lines <n>` (default 300),
`--max-packages <n>` (default 1).

### `check`

Labels each case and marks the ones a person should read. No model is called. For each case it
checks out the upgraded snapshot and collects, for each upgraded package:

- the sites of core's usage scan;
- the keys of object literals passed to the package's functions and constructors, at any depth
  (`defineConfig({ dts: { oxc: true } })`), through chains (`z.object({...}).extend({...})`), and
  the attributes of its JSX components;
- the lines writing a type imported from the package (`const x: Options`, `satisfies Plugin`,
  `Promise<Options>`), and the keys of the object such a type annotates;
- every line of an import, require or re-export of the package: a fix rewriting one follows a moved
  entry point;
- the names the code uses from the package.

The check result, written to the manifest's `labels.check`:

| Result      | Meaning                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `supported` | An expected line is a use, an option key, a type or an import of an upgraded package, or a changed line names what the code uses from one |
| `weak`      | None of that: the fix may answer the upgrade further away, or be unrelated work                                                           |
| `reformat`  | Half or more of the expected lines only changed layout, whatever they use                                                                 |
| `error`     | The snapshot could not be read                                                                                                            |

`review.md` lists the reformat, weak and error cases of the working set, with their expected lines,
for a person to keep or drop. The same for locked cases goes to `locked/review.md`. The terminal
names a locked case, never its result.

### `evaluate`

For each case `check` supports (`--all` for every case): fetches `base` and `upgraded`, checks out a
sparse worktree of `upgraded` with the files radius reads (manifests, lockfiles, configs, sources,
styles), and calls `run()` from `@dep-radius/core` with `since: base` and the case's packages. Each
upgraded package is scored:

| Field             | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `found`           | A matched note or a touched type change links to an expected line       |
| `foundBy`         | `notes`, `types`, or both                                               |
| `sameFile`        | A link lands in an expected file, on another line: a near miss          |
| `verdict`         | `quiet`, `review`, `blocked`, or `not-analysed` with the reason         |
| `matchedNotes`    | Notes radius tied to a name the code uses                               |
| `matchedNotesHit` | Matched notes with a link to an expected line                           |
| `reportedLines`   | Distinct lines radius links to, through matched notes and touched types |
| `reportedHits`    | Those lines the fix changed                                             |
| `cannotTie`       | `notes.unattributedChanges`: the notes a reader goes through by hand    |

The summary prints five numbers for the working set and for the locked set, each also split into
fixes in source and fixes in tests only:

| Number                | Definition                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **found at the line** | Cases where some package links to an expected line, over the cases with expected lines and no error                                                                 |
| **wrong quiet**       | Cases with expected lines that radius calls quiet as a whole (no package reviewed or blocked), over the same cases                                                  |
| **median cannot tie** | Median `cannotTie` over the analysed packages with expected lines                                                                                                   |
| **precision**         | Lines: the sum of `reportedHits` over the sum of `reportedLines`, every analysed package pooled. Notes: the sum of `matchedNotesHit` over the sum of `matchedNotes` |
| **quiet rate**        | Analysed packages radius calls quiet, over every analysed package of the cases                                                                                      |

Precision is a lower bound: a line radius points at may deserve a look although this fix did not
change it. Unlike the benchmark, a mined case does not know which note describes the change, so any
matched note counts.

The output looks like this (made-up numbers):

```
working: 40 cases (1 errors, 39 scored)
  found at the line   31% (12 of 39 cases)
  wrong quiet         8% (3 of 39 cases)
  median cannot tie   4 notes
  precision           22% of lines (30 of 136), 35% of matched notes (14 of 40)
  quiet rate          18% (9 of 50 analysed packages)
```

The working set also gets a per-case table; the locked set never does.

Options: `--limit <n>`, `--concurrency <n>` cases at once (default 2), `--force` to evaluate again,
`--all`. A case whose notes hit GitHub's rate limit is recorded as an error and retried on the next
run.

## Case manifest

`cases/<owner>__<repo>__<pr>.json`:

```json
{
  "id": "owner__repo__123",
  "source": "bot-pr-human-fix",
  "repo": "owner/repo",
  "pr": 123,
  "url": "https://github.com/owner/repo/pull/123",
  "title": "Update dependency zod to v4",
  "bot": "renovate",
  "mergedAt": "2026-09-01T10:00:00Z",
  "base": "<sha>",
  "upgraded": "<sha>",
  "fixes": [{ "sha": "<sha>", "author": "ada", "subject": "fix: adapt to zod 4" }],
  "fixEnd": "<sha>",
  "packages": [{ "name": "zod", "from": "3.25.76", "to": "4.1.5" }],
  "expected": [
    {
      "file": "src/schema.ts",
      "line": 12,
      "text": "  id: z.string().uuid(),",
      "imports": ["zod"]
    }
  ],
  "added": [{ "file": "src/schema.ts", "line": 12, "text": "  id: z.uuid()," }],
  "minedAt": "2026-09-14T12:00:00Z",
  "split": "working",
  "labels": {
    "bump": "major",
    "testsOnly": false,
    "reformatShare": 0,
    "expectedReformatShare": 0,
    "types": { "zod": "bundled" },
    "check": "supported"
  }
}
```

Every line number is in the `upgraded` snapshot. `imports` says which upgraded packages the line
counts for. `added` holds the lines the fix wrote in the same files, numbered in `fixEnd`.

| Label                   | Meaning                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bump`                  | The largest step among the upgrades; a 0.x minor counts as a major, as for semver's caret                                                                                     |
| `testsOnly`             | Every expected line is in a test file (test folders, `.test.`/`.spec.`, test runner setup)                                                                                    |
| `reformatShare`         | Share of the fix's removed source lines that only changed layout                                                                                                              |
| `expectedReformatShare` | The same over the expected lines                                                                                                                                              |
| `types`                 | Per package: `bundled` (a `types` field, types in `exports`, or a `.d.ts` in the tarball), `@types` (the project installs `@types/<name>`), `none`, `unknown`. Set by `check` |
| `check`                 | The `check` result. Set by `check`                                                                                                                                            |

## Data directory

`--data <dir>`, default `$XDG_CACHE_HOME/dep-radius-corpus`, else `~/.cache/dep-radius-corpus`.
Nothing is written to the repository.

```
api/graphql/      every GitHub response, by query and variables: a second run reads them
api/npm/          npm version manifests and jsDelivr file listings, by name and version
state/mine.json   search progress per query and merge window, and the outcome of every candidate
cases/            one manifest per kept case, working and locked
repos/            one partial clone per repository: commits and trees, blobs on demand
work/<id>/        the sparse worktree of a case's upgraded snapshot
briefs/<id>.json  the full radius brief of a working case
results/<id>.json the scores of a working case
report.json       the totals of both sets, and every working result
review.json, review.md  the output of check, working cases
locked/           briefs/, results/, report.json and review.* of the locked cases: not to be read
```

Every command resumes: `mine` skips candidates it has seen and continues each search from its
cursor, `evaluate` skips cases with a result unless `--force`. Delete a manifest from `cases/` to
drop a case.

## GitHub limits

The token comes from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

- `mine` uses GraphQL search, which returns each pull request's commits with it: one request per 50
  pull requests, instead of one REST call per pull request. Searches are spaced 2.1 seconds apart,
  under GitHub's 30 searches a minute.
- `evaluate` spends the REST `core` budget, through radius reading release notes. Its GitHub
  responses land in radius's own cache, so a case evaluated again costs little.
- Before each request (`mine`) or case (`evaluate`), the command stops with a message when the
  budget is under `--keep <n>` (default 500). Run it again after the reset: it resumes.
- The budget is the lower of two readings: `/rate_limit`, and the headers of a one-request probe
  (`HEAD /user` for core, a `rateLimit` query for GraphQL). `/rate_limit` alone is not trusted: it
  has been seen answering a full budget while other responses said hundreds of requests were spent.
  `mine` also follows the headers of its own responses; `evaluate` probes before every case, since
  radius spends the budget outside the tool's client.
- Git fetches go through `github.com`, not the API, and count against no budget. npm and jsDelivr
  answers count against none either.
