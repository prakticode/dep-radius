# Contributing

Thanks for helping. The most valuable contribution is a **wrong verdict**: an update radius called
quiet that broke something, or blocked for no reason.
[Open one here](https://github.com/prakticode/dep-radius/issues/new?template=wrong-verdict.yml).

## Setup

Node 22.12 or later (the repo pins 24 in `.nvmrc`) and pnpm, whose version comes from
`packageManager`.

```sh
pnpm install
pnpm build
pnpm check        # Prettier, ESLint, TypeScript and tests, cached by Turborepo
```

| Folder          | What it is                                                               |
| --------------- | ------------------------------------------------------------------------ |
| `packages/core` | The engine. Most changes land here, with a test in `packages/core/tests` |
| `packages/cli`  | The `radius` command: arguments, terminal output, progress               |
| `tooling/`      | Shared ESLint and TypeScript settings                                    |

Try your change on a real project:

```sh
pnpm build
node packages/cli/dist/cli.js --verbose     # run from inside any project
```

## Pull requests

1. Add a test that fails without your change.
2. Run `pnpm changeset` and describe the change in one sentence, for the changelog. A change to
   tests or tooling only needs no changeset.
3. `pnpm check` passes. The pre-commit hook runs formatting, lint, typecheck and tests for you.

## Conventions

- **A wrong quiet is the only fatal bug.** When the engine cannot see something, it says so and the
  verdict goes to review.
- **The `--json` output is a contract.** Version 1 only gains fields; the schema in
  `packages/core/schema` and its test change with it.
- **Comments say why**, never what the next line does.
- **Test titles state a fact** ("blocks on a removed export"), never "should".
- Imports are sorted by ESLint; run `pnpm --filter <package> lint:fix` rather than sorting by hand.
