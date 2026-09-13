# dep-radius

[![npm](https://img.shields.io/npm/v/dep-radius)](https://www.npmjs.com/package/dep-radius)
[![CI](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml/badge.svg)](https://github.com/prakticode/dep-radius/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dep-radius)](LICENSE)

Which changes in a dependency update land on code you actually wrote.

```sh
npx dep-radius                 # every dependency with an update waiting
npx dep-radius --since main    # what changed on this branch, for a pull request or an AI agent
```

The command, its options and what the verdicts mean: [packages/cli](packages/cli/README.md).

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

One comment on every pull request that changes a dependency: the verdict and the lines concerned,
edited on every push. Inputs and outputs are in [`action.yml`](action.yml).

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
