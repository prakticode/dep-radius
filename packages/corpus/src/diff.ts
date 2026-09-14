// Reads `git diff -U0 --no-renames` into the lines each side of a change holds.

import type { ExpectedLine } from "./case.ts"

export interface DiffLine {
  line: number
  text: string
}

export interface FileDiff {
  // undefined for a file the diff creates
  oldPath?: string
  // undefined for a file the diff deletes
  newPath?: string
  // lines of the old side the diff removes or rewrites, numbered in the old file
  removed: DiffLine[]
  // lines of the new side the diff writes, numbered in the new file
  added: DiffLine[]
}

// The extensions radius scans for usage.
export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/

const ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  '"': 34,
  "\\": 92,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
}

function unquote(s: string): string {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"))
      continue
    }
    const oct = /^[0-7]{3}/.exec(s.slice(i + 1))
    if (oct) {
      bytes.push(parseInt(oct[0], 8))
      i += 3
    } else {
      const next = s[++i] ?? ""
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
    }
  }
  return Buffer.from(bytes).toString("utf8")
}

function pathOf(header: string, prefix: "a/" | "b/"): string | undefined {
  let p = header.replace(/^(?:---|\+\+\+) /, "").replace(/\t.*$/, "")
  if (p === "/dev/null") return undefined
  // git quotes a path holding unusual characters, with C escapes of its UTF-8 bytes inside
  if (p.startsWith('"') && p.endsWith('"')) p = unquote(p.slice(1, -1))
  return p.startsWith(prefix) ? p.slice(prefix.length) : p
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | undefined
  let oldLine = 0
  let newLine = 0
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = { removed: [], added: [] }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (raw.startsWith("--- ")) {
      cur.oldPath = pathOf(raw, "a/")
      continue
    }
    if (raw.startsWith("+++ ")) {
      cur.newPath = pathOf(raw, "b/")
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[3])
      continue
    }
    if (raw.startsWith("-")) {
      cur.removed.push({ line: oldLine++, text: raw.slice(1) })
    } else if (raw.startsWith("+")) {
      cur.added.push({ line: newLine++, text: raw.slice(1) })
    } else if (raw.startsWith(" ")) {
      // context lines only appear without -U0, and advance both sides
      oldLine++
      newLine++
    }
  }
  return files
}

// `import ... from "pkg"`, `import "pkg/sub"`, `require("pkg")`, `import("pkg")`, and the
// `export ... from "pkg"` forms. The usage scan decides what a file really uses; this only keeps
// the files a person would call related to the package.
export function importsPackage(source: string, pkg: string): boolean {
  const n = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  return new RegExp(
    `(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)["']${n}(?:/[^"']*)?["']`
  ).test(source)
}

// Blank lines and lines holding only punctuation or a comment carry no call to point at.
export function meaningful(text: string): boolean {
  const t = text.trim()
  return (
    t.length > 0 && !/^(?:\/\/|\/\*|\*|<!--)/.test(t) && /[A-Za-z0-9_$]/.test(t)
  )
}

export interface Expectation {
  expected: ExpectedLine[]
  added: { file: string; line: number; text: string }[]
  // why nothing was kept, when nothing was
  empty?:
    | "fix changes no source file"
    | "fix only adds lines"
    | "no changed file imports an upgraded package"
}

// The removed or rewritten lines of source files importing an upgraded package. `sourceAt` reads a
// file of the upgraded snapshot.
export function expectedLines(
  files: FileDiff[],
  packages: string[],
  sourceAt: (path: string) => string | undefined
): Expectation {
  const sources = files.filter(
    (f) => f.oldPath !== undefined && SOURCE_FILE.test(f.oldPath)
  )
  if (sources.length === 0)
    return { expected: [], added: [], empty: "fix changes no source file" }
  const touched = sources.filter((f) =>
    f.removed.some((l) => meaningful(l.text))
  )
  if (touched.length === 0)
    return { expected: [], added: [], empty: "fix only adds lines" }
  const expected: ExpectedLine[] = []
  const added: Expectation["added"] = []
  for (const f of touched) {
    const text = sourceAt(f.oldPath!)
    if (text === undefined) continue
    const imports = packages.filter((p) => importsPackage(text, p))
    if (imports.length === 0) continue
    for (const l of f.removed)
      if (meaningful(l.text))
        expected.push({ file: f.oldPath!, line: l.line, text: l.text, imports })
    for (const l of f.added)
      if (meaningful(l.text))
        added.push({
          file: f.newPath ?? f.oldPath!,
          line: l.line,
          text: l.text,
        })
  }
  if (expected.length === 0)
    return {
      expected,
      added,
      empty: "no changed file imports an upgraded package",
    }
  return { expected, added }
}
