import { sha1 } from "../infra/hash.ts"
import type { NoteEntry, RegionKind } from "../model.ts"

// A heading says a whole section breaks; a title has to lead with it, emphasised or not ("*Breaking*:",
// "__Breaking:__"). "non-breaking" and a bullet that merely mentions breaking somewhere in its prose
// are not markers.
const BREAKING_HEADING = /(?<!non[- ])breaking|⚠️|:warning:|major changes/i
const BREAKING_TITLE =
  /^\s*(\*{1,2}|_{1,2}|\[|\()?\s*(⚠️|:warning:|breaking|💥|:boom:)|BREAKING CHANGE/i
const NOISE =
  /^(ci|chore|test|tests|docs|doc|build|style|refactor|perf\(bench\)|release|revert)(\([^)]*\))?!?:|^(deps?|dependencies)(\([^)]*\))?:|^bump\s+\S+\s+from\s|^merge (pull request|branch)|^update dependency\b|^v?\d+\.\d+\.\d+$/i

interface Draft {
  title: string
  headingPath: string[]
  kind: "bullet" | "heading" | "paragraph"
  lines: { text: string; code: boolean }[]
}

// One markdown body (a release, or a changelog section) into entries: a top-level bullet with its
// nested lines, a heading whose body is prose or code, or a stray paragraph.
export function splitEntries(version: string, markdown: string): NoteEntry[] {
  const drafts: Draft[] = []
  const stack: { level: number; text: string }[] = []
  let current: Draft | undefined
  let headingDraft: Draft | undefined
  let inFence = false
  let blankRun = 0

  const close = () => {
    if (current && (current.kind !== "heading" || current.lines.length > 0))
      drafts.push(current)
    current = undefined
  }
  const path = () => stack.map((s) => s.text)

  const lines = preprocess(markdown).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      if (!current) {
        current =
          headingDraft && !drafts.includes(headingDraft)
            ? headingDraft
            : newDraft("paragraph", firstWords(line), path())
      }
      continue
    }
    if (inFence) {
      current?.lines.push({ text: line, code: true })
      continue
    }
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    const setext =
      !atx &&
      line.trim() &&
      lines[i + 1] !== undefined &&
      /^(=+|-{3,})\s*$/.test(lines[i + 1]!) &&
      !/^\s*[-*+]\s/.test(line)
    if (atx || setext) {
      close()
      const level = atx ? atx[1]!.length : lines[i + 1]!.startsWith("=") ? 1 : 2
      const text = clean(atx ? atx[2]! : line.trim())
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level)
        stack.pop()
      headingDraft = newDraft("heading", text, path())
      stack.push({ level, text })
      current = headingDraft
      if (setext) i++
      blankRun = 0
      continue
    }
    if (!line.trim()) {
      blankRun++
      continue
    }
    const bullet = /^(\s{0,1})([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    const indent = line.length - line.trimStart().length
    if (bullet) {
      close()
      current = newDraft("bullet", clean(bullet[3] ?? ""), path())
      blankRun = 0
      continue
    }
    if (current?.kind === "bullet" && (indent >= 2 || blankRun === 0)) {
      current.lines.push({ text: line, code: false })
      blankRun = 0
      continue
    }
    if (current?.kind === "heading" || current?.kind === "paragraph") {
      current.lines.push({ text: line, code: false })
      blankRun = 0
      continue
    }
    close()
    current = newDraft("paragraph", clean(firstSentence(line)), path())
    current.lines.push({ text: line, code: false })
    blankRun = 0
  }
  close()

  const kept = drafts.filter(
    (d) => d.title || d.lines.some((l) => l.text.trim())
  )
  // an "at a glance" bullet that restates a section of the same release: the section is the entry
  const headingTitles = kept
    .filter((d) => d.kind === "heading")
    .map((d) => normTitle(d.title))
  const entries = kept
    .filter(
      (d) =>
        d.kind !== "bullet" ||
        !headingTitles.some(
          (h) => h.length >= 3 && startsWithTitle(normTitle(d.title), h)
        )
    )
    .map((d, index) => toEntry(version, d, index))
  return dedupeByRefs(entries)
}

function normTitle(s: string): string {
  return s
    .replace(/[`*_]|\u26A0\uFE0F?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function startsWithTitle(bullet: string, heading: string): boolean {
  return (
    bullet === heading ||
    (bullet.startsWith(heading) &&
      /^[\s—–:(-]/.test(bullet.slice(heading.length)))
  )
}

function newDraft(
  kind: Draft["kind"],
  title: string,
  headingPath: string[]
): Draft {
  return { kind, title, headingPath, lines: [] }
}

function toEntry(version: string, d: Draft, index: number): NoteEntry {
  const regions: NoteEntry["regions"] = []
  const pushText = (
    text: string,
    kind: Exclude<RegionKind, "code-block" | "inline-code">
  ) => {
    const parts = text.split(/(`[^`]+`)/)
    for (const p of parts) {
      if (!p) continue
      if (p.startsWith("`") && p.endsWith("`") && p.length > 1)
        regions.push({ kind: "inline-code", text: p.slice(1, -1) })
      else if (p.trim()) regions.push({ kind, text: p })
    }
  }
  pushText(d.title, "title")
  let code: string[] = []
  const flush = () => {
    if (code.length > 0)
      regions.push({ kind: "code-block", text: code.join("\n") })
    code = []
  }
  for (const l of d.lines) {
    if (l.code) code.push(l.text)
    else {
      flush()
      pushText(clean(l.text), "prose")
    }
  }
  flush()
  const all = [d.title, ...d.lines.map((l) => l.text)].join("\n")
  const refs = [
    ...new Set(
      [...all.matchAll(/(?<![\w/])#(\d{1,7})\b/g)].map((m) => `#${m[1]}`)
    ),
  ]
  const bareTitle = d.title
    .replace(/`/g, "")
    .replace(/^[0-9a-f]{7,40}\s+/, "")
    .replace(/^\*\*[^*]+\*\*:?\s*/, "")
  const titleForDisplay = d.title.replace(/`/g, "")
  return {
    id: sha1(`${version}\0${index}\0${all}`).slice(0, 12),
    version,
    title:
      titleForDisplay.length > 200
        ? `${titleForDisplay.slice(0, 197)}...`
        : titleForDisplay,
    headingPath: d.headingPath,
    regions,
    breakingMarker:
      BREAKING_TITLE.test(d.title) ||
      d.headingPath.some((h) => BREAKING_HEADING.test(h)),
    noise:
      NOISE.test(bareTitle.trim()) ||
      d.headingPath.some((h) =>
        /^(commits|contributors|new contributors)$/i.test(h.trim())
      ),
    refs,
  }
}

// The "Commits" list of a release repeats the pull requests the sections already describe.
function dedupeByRefs(entries: NoteEntry[]): NoteEntry[] {
  const covered = new Set<string>()
  for (const e of entries)
    if (
      !e.noise &&
      e.refs.length > 0 &&
      e.regions.some((r) => r.kind !== "title")
    )
      for (const r of e.refs) covered.add(r)
  return entries.filter(
    (e) =>
      !(
        e.refs.length > 0 &&
        e.refs.every((r) => covered.has(r)) &&
        e.regions.every(
          (r) => r.kind === "title" || r.kind === "inline-code"
        ) &&
        isShadowed(e, entries)
      )
  )
}

function isShadowed(e: NoteEntry, entries: NoteEntry[]): boolean {
  return entries.some(
    (o) =>
      o !== e &&
      o.regions.length > e.regions.length &&
      e.refs.every((r) => o.refs.includes(r))
  )
}

function preprocess(md: string): string {
  return (
    md
      .replace(/<!--[\s\S]*?-->/g, "")
      // a pull request URL is a ref, keep it as one before links are dropped
      .replace(
        /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/(\d+)/g,
        "#$1"
      )
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<img\b[^>]*>/gi, "")
      .replace(
        /<\/?(details|summary|p|div|br|sup|sub|b|i|em|strong|span|a)\b[^>]*>/gi,
        " "
      )
  )
}

function clean(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function firstSentence(s: string): string {
  const t = clean(s)
  const m = /^(.{20,160}?[.!?])(\s|$)/.exec(t)
  return m?.[1] ?? t.slice(0, 160)
}

function firstWords(s: string): string {
  return s.replace(/[`~]/g, "").trim().slice(0, 40)
}
