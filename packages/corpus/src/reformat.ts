// Which removed lines of a fix come back unchanged but for layout: a formatter's upgrade, a wrap
// moved, imports sorted again. Such a line was not broken by the upgrade, so it makes a false
// expected line.

import type { DiffLine, FileDiff } from "./diff.ts"

// Whitespace, commas and semicolons are what formatters add, drop and move; quotes change style;
// parentheses around a lone arrow parameter come and go with a setting.
export function normalizeLayout(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[,;]/g, "")
    .replace(/["'`]/g, '"')
    .replace(/\(([A-Za-z_$][\w$]*)\)=>/g, "$1=>")
}

// A run shorter than this matches inside any rewritten text by chance.
const MIN_RUN = 6

function runs(lines: DiffLine[]): DiffLine[][] {
  const out: DiffLine[][] = []
  for (const l of lines) {
    const last = out.at(-1)
    if (last && last.at(-1)!.line + 1 === l.line) last.push(l)
    else out.push([l])
  }
  return out
}

// The removed lines, `file:line`, that only changed layout. A removed line is reformatted when the
// fix writes the same text again anywhere in the file (a line moved or imports reordered), or when
// a run of removed lines reads, joined, as the joined text the file gains (a call wrapped or
// unwrapped).
export function reformattedLines(files: FileDiff[]): Set<string> {
  const out = new Set<string>()
  for (const f of files) {
    if (!f.oldPath) continue
    const pool = new Map<string, number>()
    for (const a of f.added) {
      const n = normalizeLayout(a.text)
      if (n) pool.set(n, (pool.get(n) ?? 0) + 1)
    }
    const rest: DiffLine[] = []
    for (const r of f.removed) {
      const n = normalizeLayout(r.text)
      const left = pool.get(n) ?? 0
      if (n && left > 0) {
        pool.set(n, left - 1)
        out.add(`${f.oldPath}:${r.line}`)
      } else rest.push(r)
    }
    if (rest.length === 0) continue
    const gained = f.added.map((a) => normalizeLayout(a.text)).join("")
    for (const run of runs(rest)) {
      const joined = run.map((r) => normalizeLayout(r.text)).join("")
      if (joined.length >= MIN_RUN && gained.includes(joined))
        for (const r of run) out.add(`${f.oldPath}:${r.line}`)
    }
  }
  return out
}

export function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

// Most removed lines are layout: the fix answers a formatter, not the upgrade.
export const REFORMAT_SHARE = 0.5
