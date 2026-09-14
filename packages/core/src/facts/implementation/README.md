# Implementation facts

For each export of a package version: which of the package's own functions it can run, and a
fingerprint of each one's code. Two versions compared give the exports whose code changed inside,
and the functions that changed. Not used by any verdict yet: this folder is a measured spike.

## Why

Name matching misses notes that name a neighbour. A note says "avoid calling `setItem`", the project
calls `persist()`, and `persist` calls `setItem` inside. Types cannot say that. The code can.

## How it works

1. **Files.** The tarball's JavaScript, read from the same cached archive as the types
   (`getTarballFiles(..., "runtime")`).
2. **Entries.** `package.json` `exports`, `module`, `main`, read the way Node does: conditions in
   the order the map lists them. ESM is read only when both versions publish it, so both sides of a
   diff read the same build (`flavorFor`).
3. **Units.** Each file is parsed with the TypeScript parser. A unit is a named piece of code: a
   function, a class (constructor and fields), a method, an object member, a module-level value.
   Nested functions are their own units (`persist/hydrate`). ES5 classes (`Foo.prototype.bar =`),
   IIFE and UMD wrappers, Babel, TypeScript and esbuild CommonJS output are recognised.
4. **Exports.** ESM `export`, CommonJS `exports.x`, `module.exports = ...`, compiled
   `Object.defineProperty(exports, ...)` getters, `export *` and `__exportStar`. They are spelled as
   `symbol-path.ts` spells them: `pkg:name`, `pkg/sub:name`, `pkg:Class#method`, `pkg:` for
   `module.exports` itself.
5. **Call graph.** Static and conservative. A unit calls what its names resolve to: nested and
   module-level declarations, imports followed through relative paths, `#imports` and the package's
   own name. `this.x()` goes to the class's method. `x.name()` on a value the graph lost goes to
   every method called `name`, when there are at most 4. A class handed on as a value brings all its
   methods.
6. **Fingerprint.** A hash of the unit's tokens, blind to whitespace, comments, semicolons, trailing
   commas, quote style, `let`/`const`/`var`, and the names of its own parameters and locals. Nested
   units appear only as their names, so a change is reported in the unit where it happened. In a
   minified file, module-level names are blanked too, and functions compare by code instead of by
   name.
7. **Diff.** For each export present in both versions: the multiset of (unit name, fingerprint) over
   everything it can reach. Any difference makes the export changed, with the unit names that
   differ.
8. **Bounds.** At most 600 files, 2 MB per file, 40,000 units, 4,000 exports, 6,000,000 syntax nodes
   visited (a work budget instead of a clock, so the result never depends on the machine), and
   20,000 units per reach. Each cap sets a flag. Facts are cached by tarball integrity, algorithm
   version and build.

## The measurement

`node scripts/implementation-spike.ts` runs it on the 51 benchmark cases, with the real packages
from the registry. A note is linked by one of three rules, from strict to loose:

- **unit**: a code name in the note is a unit that changed under an export the project uses.
- **near**: it is a changed unit, or something a changed unit calls directly.
- **reach**: it is anything a changed export the project uses can reach.

"Other" counts the release's other entries the same rule links. They are not all wrong (a `ws` note
about the `WebSocket` constructor is about code the project uses), but they are what a reader would
be shown in addition to the change.

| Upgrades | Cases | Exports changed (median) | unit: change / other | near: change / other | reach: change / other | Entries |
| -------- | ----: | -----------------------: | -------------------: | -------------------: | --------------------: | ------: |
| patch    |     9 |                      17% |                3 / 0 |                6 / 5 |                 6 / 8 |      37 |
| minor    |    17 |                      75% |               6 / 71 |               9 / 97 |               9 / 101 |     233 |
| major    |    25 |                      67% |               5 / 40 |              12 / 80 |               13 / 81 |     334 |
| all      |    51 |                      67% |             14 / 111 |             27 / 182 |              28 / 190 |     604 |

Other numbers:

- A used export was found in all 51 cases, and one of them changed inside in 50. On this benchmark
  every case is a real change, so that says the signal does not miss, not that it is precise.
- 30 change notes name code that exists in the package. The loose rule reaches 28 of them, the near
  rule 27, the unit rule 14.
- Time: median 55 ms, at most 544 ms, for both versions of a package together (tarballs cached). No
  failures.
- The same files give the same facts: two runs produce identical output.

Examples:

- `zustand` 4.5.4 to 4.5.5: 1 export of 20 changed, `persist`, in `newImpl/hydrate`, which calls
  `setItem`. The note "avoid calling setItem" is linked by the near rule, and nothing else is.
- `rxjs` 7.8.0 to 7.8.1: 8 of 449 exports changed. `throttleTime` changed through `throttle`, which
  the note's scope `throttle:` names. The other note (`asapScheduler`) is not linked, since the
  project does not use it.
- `zod` 4.x minors: 1,936 of 2,115 exports changed, because every schema reaches a shared core that
  changed. Every rule links 20 or more of 29 entries.

## Conclusion

- **Precise on patches, noisy on minors and majors.** In a patch few exports change (median 17%),
  and a note naming a changed internal function points at the right export with almost no noise
  (unit rule: 3 linked, 0 others; near rule: 6 linked, 5 others). In minors and majors most exports
  change, because a refactor touches shared code that everything reaches, so any name in any note
  tends to land.
- **Good enough to link notes that name internal functions, with the near rule, when few exports
  changed.** It finds the neighbour case it was built for (`setItem`, `throttle`) without special
  cases.
- **Not good enough to rank "cannot tie" notes on its own.** "Your export changed inside" is true in
  50 of 51 cases, including upgrades where most of the package changed. As a ranking signal it only
  separates anything when the share of changed exports is small.

## Limits

- Static only: `obj[name]()`, callbacks stored in data, `Object.assign(Foo.prototype, mixin)`, and
  plugins installed at runtime (`require("./resize")(Sharp)`) are not followed. Such exports reach
  less than they run.
- Over-approximation: member calls by name, whole modules used as values and classes handed on bring
  in code that may never run. Shared cores make most exports reach most code.
- Names, not scopes: a local that shadows a module-level name still links to it.
- Other packages are not followed: a change in a dependency is invisible.
- A new build tool changes every fingerprint (helper renames such as `_toThenable`, a different
  target). Minified names are blanked, but a re-minified bundle still differs wherever the minifier
  reordered code.
- Top-level statements that are not declarations (module setup code) belong to no unit and are not
  compared.
- Exports are those of the chosen build; a package whose ESM and CommonJS builds differ is read
  through one of them.

## Recommendation

Wire it in as a ranking and linking hint, never as a verdict, and only where it is precise:

1. Compute the diff only for packages the project uses by name, next to the type surface, from the
   same cached tarball.
2. Use the **near** rule to link a note whose code names are not in the type surface: a changed
   unit, or what one calls, under an export the project uses. Show it as "linked through the
   package's code", weaker than a name match.
3. Turn the hint off when more than about a quarter of the exports the project could use changed:
   past that, it links everything.
4. Use "no export the project uses changed inside" as evidence for moving a "cannot tie" note down,
   never for dropping it: a change in a dependency, a runtime plugin or a missed call would be
   silent.
5. Before trusting it more, measure it on upgrades where the project did not need a change: this
   benchmark has only real changes, so it measures misses, not false alarms.
