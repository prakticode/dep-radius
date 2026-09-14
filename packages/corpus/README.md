# @dep-radius/corpus

Collects real upgrade cases from GitHub and measures radius on them. Private, never published.

The source is the bot pull request a person had to fix: Renovate or Dependabot upgrades a package,
and before merging, someone pushes a commit on the bot's branch. That commit shows the lines the
upgrade broke, written by the project's own maintainer.

```sh
pnpm corpus:mine --limit 40     # find cases
pnpm corpus:evaluate            # run radius on them, print the score
pnpm corpus:check               # flag the cases a person should read
pnpm corpus --help
```

`pnpm corpus` builds `@dep-radius/core` first, then runs `node packages/corpus/src/cli.ts`.

## Commands

### `mine`

Searches merged pull requests by `renovate[bot]` and `dependabot[bot]` in public JavaScript and
TypeScript repositories, one merge day at a time, newest first. A pull request is a **candidate**
when a commit on it was written by a person (not a bot, not a merge). For each candidate:

1. **Commits.** `base` is the parent of the first commit. `upgraded` is the commit just before the
   first human one: upgraded, not yet fixed. The fix runs from there to the last human commit before
   any merge commit, since a merge brings the base branch's own changes.
2. **Packages.** The direct dependencies whose locked version went up from `base` to `upgraded`,
   read with core's inventory and paired the way `radius --since` pairs them.
3. **Expected lines.** `git diff -U0 upgraded..fixEnd` on source files: JavaScript and TypeScript in
   every variant, Vue, Svelte and Astro. A removed or rewritten line is expected when its file
   imports an upgraded package. Blank lines, comments and punctuation-only lines are left out.

A candidate is rejected, with the reason recorded, when:

| Reason                                        | Meaning                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `first commit is not by a bot`                | A person opened the branch                                 |
| `merge commit before the fix`                 | The upgraded snapshot mixes in the base branch             |
| `git fetch failed`                            | The repository or the commits are gone                     |
| `could not read the lockfiles`                | No lockfile core can read at one of the commits            |
| `no dependency upgraded`                      | No locked direct dependency version went up                |
| `fix changes no source file`                  | Only lockfiles, configs or docs changed                    |
| `fix only adds lines`                         | Nothing existing was removed or rewritten                  |
| `no changed file imports an upgraded package` | The fix is in code that does not use the packages          |
| `fix too large`                               | More than `--max-lines` expected lines: a reformat or more |

Options: `--limit <n>` candidates per run (default 40), `--since <date>` and `--until <date>` merge
days (default the last 90 days, ending yesterday), `--query <q>` to replace the searches
(repeatable, `merged:<day>` is appended), `--max-lines <n>` (default 300).

### `evaluate`

For each case: fetches `base` and `upgraded`, checks out a sparse worktree of `upgraded` with the
files radius reads (manifests, lockfiles, configs, sources, styles), and calls `run()` from
`@dep-radius/core` with `since: base` and the case's packages. Each package with expected lines is
scored:

| Field          | Meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `found`        | A matched note or a touched type change links to an expected line    |
| `foundBy`      | `notes`, `types`, or both                                            |
| `sameFile`     | A link lands in an expected file, on another line: a near miss       |
| `verdict`      | `quiet`, `review`, `blocked`, or `not-analysed` with the reason      |
| `matchedNotes` | Notes radius tied to a name the code uses                            |
| `cannotTie`    | `notes.unattributedChanges`: the notes a reader goes through by hand |

The summary gives found per case and per package, **wrong quiet** (a case radius calls quiet as a
whole although a person had to fix it, and packages called quiet), and the **median list length**
(median `cannotTie`). Unlike the benchmark, a mined case does not know which note describes the
change, so any matched note counts.

Options: `--limit <n>`, `--concurrency <n>` cases at once (default 2), `--force` to evaluate again.
A case whose notes hit GitHub's rate limit is recorded as an error and retried on the next run.

### `check`

Scans the upgraded snapshot with core's usage scan and marks a case **weak** when no expected line
is a use of an upgraded package and no removed or written line mentions a name the code uses from
one. Weak cases are not dropped: `review.md` lists them for a person or an AI to read. No model is
called.

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
  "minedAt": "2026-09-14T12:00:00Z"
}
```

Every line number is in the `upgraded` snapshot. `imports` says which upgraded packages the line
counts for. `added` holds the lines the fix wrote in the same files, numbered in `fixEnd`.

## Data directory

`--data <dir>`, default `$XDG_CACHE_HOME/dep-radius-corpus`, else `~/.cache/dep-radius-corpus`.
Nothing is written to the repository.

```
api/graphql/   every GitHub response, by query and variables: a second run reads them
state/mine.json  search progress per query and day, and the outcome of every candidate
cases/         one manifest per kept case
repos/         one partial clone per repository: commits and trees, blobs on demand
work/<id>/     the sparse worktree of a case's upgraded snapshot
briefs/<id>.json  the full radius brief of a case
results/<id>.json the scores of a case
report.json    every result, with the totals
review.json, review.md  the output of check
```

Every command resumes: `mine` skips candidates it has seen and continues each day's search from its
cursor, `evaluate` skips cases with a result unless `--force`. Delete a manifest from `cases/` to
drop a case.

## GitHub limits

The token comes from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

- `mine` uses GraphQL search, which returns each pull request's commits with it: one request per 50
  pull requests, instead of one REST call per pull request. Searches are spaced 2.1 seconds apart,
  under GitHub's 30 searches a minute. A search returns 1000 results at most, hence one day per
  search.
- `evaluate` spends the REST `core` budget, through radius reading release notes. Its GitHub
  responses land in radius's own cache, so a case evaluated again costs little.
- Before each request (`mine`) or case (`evaluate`), the command stops with a message when the
  budget is under `--keep <n>` (default 500). Run it again after the reset: it resumes.
- The budget is the lower of two readings: `/rate_limit`, and the headers of a one-request probe
  (`HEAD /user` for core, a `rateLimit` query for GraphQL). `/rate_limit` alone is not trusted: it
  has been seen answering a full budget while other responses said hundreds of requests were spent.
  `mine` also follows the headers of its own responses; `evaluate` probes before every case, since
  radius spends the budget outside the tool's client.
- Git fetches go through `github.com`, not the API, and count against no budget.
