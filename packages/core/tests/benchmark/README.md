# Behaviour change benchmark

Real release notes that changed behaviour, and the lines of a project they land on. It measures one
thing: does radius tie a documented behaviour change to the code it affects?

```sh
pnpm benchmark          # the table and the totals
pnpm benchmark --json   # the same, for a script
```

The cases also run with the tests (`benchmark.test.ts`). Each one records whether radius catches it
today, so a change to matching that catches a new case, or loses one, fails the test until the case
is updated on purpose.

## What a case is

```
cases/<package>-<change>/
  case.json     the change, the lines it lands on, and what radius does today
  notes/        the release notes, copied verbatim, one file per version
  project/      a small project using the package the way real code does
```

| Field        | What                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| `package`    | The npm package                                                                    |
| `from`, `to` | The upgrade                                                                        |
| `repository` | The GitHub repository the notes come from                                          |
| `sources`    | For each file in `notes/`, the URL it was copied from                              |
| `change`     | Words from the notes that only the entries describing the change contain           |
| `why`        | What breaks at runtime, in one or two sentences                                    |
| `expect`     | The `file:line` sites the change lands on                                          |
| `status`     | `caught` when radius links the change to at least one expected site, else `missed` |

Each case runs the full pipeline against the fake registry, with the notes served as GitHub releases
and the type surface turned off: this measures the notes, not the types.

## The numbers

- **Recall**: the share of cases caught.
- **Precision**: of every note a reader is shown across the cases, the share that describes the
  change. The rest is what they skim past.
- **sites**: expected sites linked, out of those listed.
- **other notes**: matched notes that are not the change, out of every entry read.

## Adding a case

1. Pick a documented change that still compiles: a new default, a stricter check, a different return
   value. Removed exports are the types' job.
2. Copy the notes exactly as published into `notes/<version>.md`: the release body, or the version's
   section of the changelog without its heading. Never rewrite them.
3. Write the smallest project that uses the package the way real code does, without adding names
   just so the note matches.
4. Write `expect` from what the change breaks, before running radius.
5. Run `pnpm benchmark`, and set `status` to what it reports.

A missed case is as useful as a caught one: it is the next thing to fix.
