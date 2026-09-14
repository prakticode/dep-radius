import type { NoteEntry } from "../model.ts"

// The words of a note that read as code, whatever the package: every identifier written as code
// (`setItem`, an example), a word shaped like code in the text (camelCase, snake_case, a digit, an
// inner capital), and the scope a commit title starts with (`throttle: ...`, `fix(storage): ...`,
// `**throttle:** ...`). Plain English words are left out: a package often has a function named
// `state` or `update`, and a note saying "state" rarely means it.

const IDENTIFIER = /[A-Za-z_$][\w$]*/g

function looksLikeCode(word: string): boolean {
  return /[a-z][A-Z]|[_$]|\d/.test(word) || /^[A-Z][a-z]+[A-Z]/.test(word)
}

// `throttle: fix`, `fix(storage): ...`, `**throttle:** ...`, after a commit hash or pull request numbers
function scopeOf(title: string): string | undefined {
  const bare = title
    .replace(/`/g, "")
    .replace(/^[0-9a-f]{7,40}\s+/, "")
    .replace(/^(?:#\d+\s+)+/, "")
    .replace(/^\*\*([^*]+?):?\*\*:?\s*/, "$1: ")
  const m = /^(?:[a-z]+\(([\w$./-]+)\)!?|([\w$]+)):\s/.exec(bare)
  const scope = m?.[1] ?? m?.[2]
  // `fix(core/storage)`: the last segment is the most specific name
  return scope?.split(/[./]/).pop()
}

export function codeNames(e: NoteEntry): string[] {
  const out = new Set<string>()
  for (const r of e.regions)
    if (r.kind === "inline-code" || r.kind === "code-block")
      for (const m of r.text.matchAll(IDENTIFIER)) out.add(m[0])
  for (const text of [e.title, ...e.regions.map((r) => r.text)])
    for (const m of text.matchAll(IDENTIFIER))
      if (looksLikeCode(m[0])) out.add(m[0])
  const scope = scopeOf(e.title)
  if (scope) out.add(scope)
  return [...out].filter((w) => w.length >= 3).sort()
}
