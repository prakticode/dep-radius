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

## Packages

| Package                                                  | npm                | What it is                      |
| -------------------------------------------------------- | ------------------ | ------------------------------- |
| [`packages/cli`](packages/cli)                           | `dep-radius`       | The `radius` command            |
| [`packages/core`](packages/core)                         | `@dep-radius/core` | The engine, usable as a library |
| [`tooling/eslint-config`](tooling/eslint-config)         | private            | Shared ESLint rules             |
| [`tooling/typescript-config`](tooling/typescript-config) | private            | Shared TypeScript settings      |

`@dep-radius/core` and `dep-radius` are released together, with the same version.

## Working on it

Requires Node 22.12 or later and pnpm.

```sh
pnpm install
pnpm build          # every package, core first
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
