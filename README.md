# dep-radius

[![npm](https://img.shields.io/npm/v/dep-radius)](https://www.npmjs.com/package/dep-radius)
[![CI](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml/badge.svg)](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dep-radius)](LICENSE)

radius tells your AI agent which changes in a dependency upgrade affect your code, with the files
and lines to check.

```sh
npx dep-radius --since HEAD --json   # after an upgrade, for an agent
npx dep-radius                       # every dependency with an update, for you
```

## The problem

Your agent upgrades `zod` from 4.4.3 to 4.5.0. The code compiles. The tests pass. The agent says
it's done.

But the release notes say: "`.min()` now counts an emoji as one character." Your feedback form uses
`z.string().min(10)`. A message with five emoji used to pass. Now it's rejected.

Nothing failed, because nothing checked the release notes against your code.

## What radius does

It reads the release notes and the type files of both versions, finds every place your code uses the
package, and shows which changes affect it:

```txt
zod  4.4.3 → 4.5.0  minor   REVIEW
  4.5.0  ⚠️ String length counts code points
    you use: string, max, min
    src/feedback/schema.ts:5  (via src/lib/zod.ts)
```

Real output, shortened. radius found the line even though the file imports zod through another file.

| Answer      | Means                                                           | Exit |
| ----------- | --------------------------------------------------------------- | ---- |
| **quiet**   | Nothing your code uses changed. You can merge.                  | `0`  |
| **review**  | Some changes may affect your code. Here are the lines.          | `1`  |
| **blocked** | Something your code calls was removed. Here is where it's used. | `2`  |

## Use it in your agent

Paste this into `CLAUDE.md`, `AGENTS.md`, or your agent's rules file:

```md
## Dependency upgrades

After you change a dependency version, run this before you say you're done:

    npx dep-radius --since HEAD --json

- Exit 0: nothing this project uses changed. Run the tests.
- Exit 1 or 2: open each file and line it lists. Fix what the change breaks. Run or add tests for
  those files. Run it again.
- Exit 3: radius failed. Say so.

Tests are still required.
```

The full version, with the JSON fields: [the agent guide](https://depradius.com/docs/agents).

**How I use it:** I don't run radius myself. This block is in my projects' `CLAUDE.md`. When Claude
Code upgrades a dependency, it runs radius, checks the lines, and runs the tests.

## Questions

**Is it an AI?** No. It reads your code with the TypeScript parser and compares files. Same project,
same versions: same answer, every time.

**Does my code leave my machine?** No. radius only downloads information about packages from your
npm registry and GitHub. It never installs or runs them.

**What can it miss?** A change nobody wrote in the release notes. That's why the tests still run.

**Why is almost everything review?** Most releases include a fix written in plain words. radius
can't prove it doesn't affect you, so it shows it. About one update in ten is quiet.

**Does it work?** On
[51 real release notes that changed behaviour](https://depradius.com/docs/benchmark), it found the
exact line for 24, and called none of them quiet by mistake. Every miss is listed.

**What does it need?** Nothing: `npx dep-radius`. No account, no config. npm, pnpm, Yarn, Bun,
monorepos, private registries. Three direct dependencies, published with npm provenance. MIT.

**Does it replace Renovate or Dependabot?** No. They tell you an update exists. radius tells you
what it changes for your code.

Documentation: [depradius.com](https://depradius.com). All options:
[packages/cli](packages/cli/README.md).

## On pull requests

```yaml
# .github/workflows/dep-radius.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  brief:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: prakticode/dep-radius@v0
```

A comment on every pull request that changes a dependency, with the answer and the lines to check.
It updates on every push. Inputs and outputs are in [`action.yml`](action.yml), and the setup is in
[the GitHub Action guide](https://depradius.com/docs/github-action).

## Packages

| Package                                                  | npm                | What it is                                                           |
| -------------------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| [`packages/cli`](packages/cli)                           | `dep-radius`       | The `radius` command                                                 |
| [`packages/core`](packages/core)                         | `@dep-radius/core` | The engine, usable as a library                                      |
| [`packages/action`](packages/action)                     | private            | The GitHub Action's report step, run from [`action.yml`](action.yml) |
| [`apps/docs`](apps/docs)                                 | private            | The documentation site, Fumadocs on Next.js                          |
| [`tooling/eslint-config`](tooling/eslint-config)         | private            | Shared ESLint rules                                                  |
| [`tooling/typescript-config`](tooling/typescript-config) | private            | Shared TypeScript settings                                           |

`@dep-radius/core` and `dep-radius` are released together, with the same version.

## Working on it

Requires Node 22.12 or later and pnpm.

```sh
pnpm install
pnpm build          # every package, core first, and the docs site
pnpm --filter @dep-radius/docs dev   # the docs on http://localhost:3000
pnpm check          # format, lint, typecheck and tests, cached by Turborepo
pnpm changeset      # describe a change for the next release
```

Run the CLI from source on any project:

```sh
pnpm build
node packages/cli/dist/cli.js      # or: pnpm --filter dep-radius dev, from the project folder
```

Replay a repository's past upgrades through radius:

```sh
pnpm backtest <path-to-repo> --since 2025-09-01 --max 40 --out results.jsonl
```

## License

MIT
