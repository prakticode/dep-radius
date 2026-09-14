---
"@dep-radius/core": minor
"dep-radius": minor
---

An update is no longer quiet while one of its release notes describes a change radius cannot tie to
your code: a fix or a change that names no API ("Remove empty non-boolean attributes"), or names one
radius cannot place because the package has no types. Such an update goes to review with the reason
`unattributed-change`, and the notes are listed, so there are a few lines to read instead of a
changelog. Housekeeping (docs, tests, CI, dependency updates, thanks, bare links) and additions (new
features, options, speed-ups) do not count.

Expect far fewer quiet verdicts: on 451 past upgrades of umami, uptime-kuma and outline, quiet went
from 180 (40%) to 43 (10%), and no upgrade became quiet that was not before. In exchange, radius
stops calling quiet the documented behaviour changes it could not connect to the code, 13 of the 51
in its benchmark.

`--json` gains `notes.changesWithoutApi`.
