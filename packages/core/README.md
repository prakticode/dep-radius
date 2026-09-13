# @dep-radius/core

The engine behind [`dep-radius`](../cli/README.md): which changes in a dependency update land on
code you actually wrote. Use it to build your own integration; for the command line, install
`dep-radius`.

```ts
import { createCtx, defaultCacheDir, renderJson, run, type Options } from "@dep-radius/core"

const options: Options = {
  root: process.cwd(),
  specs: [],
  format: "json",
  offline: false,
  minAgeMs: undefined,
  latest: false,
  notes: true,
  surface: true,
  prod: false,
  concurrency: 8,
  cacheDir: defaultCacheDir(process.env),
  verbose: false,
  now: Date.now(),
  color: false,
}

const brief = await run(options, createCtx(options), (event) => {
  if (event.type === "package") console.error(`${event.done}/${event.total}`)
})

process.stdout.write(renderJson(brief))
process.exitCode = brief.exitCode
```

## Entry points

| Import                                         | Contains                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `@dep-radius/core`                             | `run`, `createCtx`, the brief types, `renderJson`, `renderMarkdown` |
| `@dep-radius/core/render`                      | Grouping and labels, to write another renderer                      |
| `@dep-radius/core/schema/brief-v1.schema.json` | The JSON Schema of `renderJson`'s output                            |

The JSON output is a stable contract (`schemaVersion: 1`). The TypeScript types of the internal
brief may still change before 1.0.

## License

MIT
