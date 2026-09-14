import { sha1 } from "../infra/hash.ts"
import type { EntryKind, NoteEntry, RegionKind } from "../model.ts"

// A heading says a whole section breaks; a title has to lead with it, emphasised or not ("*Breaking*:",
// "__Breaking:__"). "non-breaking" and a bullet that merely mentions breaking somewhere in its prose
// are not markers.
const BREAKING_HEADING = /(?<!non[- ])breaking|⚠️|:warning:|major changes/i
const BREAKING_TITLE =
  /^\s*(\*{1,2}|_{1,2}|\[|\()?\s*(⚠️|:warning:|breaking|💥|:boom:)|BREAKING CHANGE/i
const NOISE =
  /^(ci|chore|test|tests|docs|doc|build|style|refactor|perf\(bench\)|release|revert)(\([^)]*\))?!?:|^(deps?|dependencies)(\([^)]*\))?:|^bump\s+\S+\s+from\s|^merge (pull request|branch)|^update dependency\b|^v?\d+\.\d+\.\d+$/i
// Housekeeping written other ways: a conventional scope that is about the project, not the package
// (`fix(types):`, `fix(docs):`, `readme:`), a bracketed tag (`[meta]`, `[Dev Deps]`), dependency
// updates, thanks, and the lines release tools add around the notes.
const HOUSEKEEPING =
  /^\w+\((types?|typings?|typescript|docs?|readme|ci|tests?|deps?|deps-dev|build|release|lint|examples?|website)\)!?:|^(readme|internal|release|examples?|website)\s*:|^\[(meta|actions|dev deps|deps|tests?|docs?|readme|ci|refactor|robustness)\]|^updated? dependencies\b|^(special )?thanks\b|^kudos\b|^full changelog\b|^no significant changes\b|^new contributors?\b|^(commits|contributors)$|^(upgrade|update|bump)\b.*\b(dev-?dependenc\w*|version)\b|^(upgrade|update|bump)\s+\S+\s+(from|to)\s+v?[\^~]?\d/i
// Work on the project itself, said in words: its tests, linting, spelling, CI, package manager, docs.
const PROJECT_WORK =
  /\b(linter|lint fixes|spelling|typos?|test suite|tests? for|in tests|ci\b|dtslint|package manager|readme|documentation|jsdoc)\b/i
// Only the declarations changed: the type surface compares those, the notes add nothing.
const TYPES_ONLY =
  /^(typescript|types?|typings?)\s*:|^(improve|update|fix)\s+(the\s+)?(typing|typings|types|type definitions?)\b|\bindex\.d\.ts\b/i
// What adds without changing what exists: a feature, a new option, a speed-up.
const ADDITION_TITLE =
  /^(feat|feature|perf)(\([^)]*\))?!?:|^(add|adds|added|new|support|supports|introduce|introduces|expose|exposes|allow|allows)\b/i
const ADDITION_HEADING = /feature|added|\bnew\b|performance|\bperf\b/i
// "npm install zod@latest" under a release's opening sentence: how to get it, not what changed.
const INSTALL_COMMAND = /^\s*(npm|pnpm|yarn|bun|npx)\s+(install|add|i)\b/m
// A pointer elsewhere, with nothing said in the entry itself.
const REFERENCE =
  /\b(migration guide|upgrade guide|blog post|announcement|release notes|changelog)\b/i

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

  const kept = expandSections(drafts).filter(
    (d) => d.title || d.lines.some((l) => l.text.trim())
  )
  // the paragraphs a release opens with, before its first heading or list
  const firstListed = kept.findIndex((d) => d.kind !== "paragraph")
  const intros = new Set(
    firstListed > 0 && kept.length - firstListed >= 2
      ? kept.slice(0, firstListed)
      : []
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
    .map((d, index) => toEntry(version, d, index, intros.has(d)))
  return dedupeByRefs(entries)
}

// "breaking:", "**resolve**:" with the changes listed under it: each nested item is the entry, and
// the label becomes part of where it sits, so a breaking label still marks its items.
function expandSections(drafts: Draft[]): Draft[] {
  const out: Draft[] = []
  for (const d of drafts) {
    const nested = d.lines.filter((l) => !l.code && /^\s+[-*+]\s+/.test(l.text))
    if (d.kind !== "bullet" || !/:\s*$/.test(d.title) || nested.length === 0) {
      out.push(d)
      continue
    }
    const indentOf = (text: string) => text.length - text.trimStart().length
    const top = Math.min(...nested.map((l) => indentOf(l.text)))
    const label = d.title.replace(/:\s*$/, "").trim()
    const children: Draft[] = []
    const intro: Draft["lines"] = []
    for (const l of d.lines) {
      const item = /^(\s+)[-*+]\s+(.*)$/.exec(l.text)
      if (!l.code && item && indentOf(l.text) === top)
        children.push(
          newDraft("bullet", clean(item[2] ?? ""), [...d.headingPath, label])
        )
      else if (children.length > 0) children.at(-1)!.lines.push(l)
      else intro.push(l)
    }
    if (intro.some((l) => l.text.trim())) out.push({ ...d, lines: intro })
    out.push(...children)
  }
  return out
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

function toEntry(
  version: string,
  d: Draft,
  index: number,
  intro: boolean
): NoteEntry {
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
  const titleForDisplay = d.title.replace(/`/g, "")
  const kind = kindOf(d, regions, all, intro)
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
    noise: kind === "housekeeping",
    kind,
    refs,
  }
}

// The title as a commit tool writes it, without what surrounds the words: a hash, pull request
// numbers, backticks, and a bold scope kept as a scope (`**docs:** fix` reads `docs: fix`).
function bareTitleOf(title: string): string {
  return title
    .replace(/`/g, "")
    .replace(/^[0-9a-f]{7,40}\s+/, "")
    .replace(/^(?:#\d+\s+)+/, "")
    .replace(/^\*\*([^*]+?):?\*\*:?\s*/, "$1: ")
    .replace(/^backport:\s*/i, "")
    .trim()
}

function kindOf(
  d: Draft,
  regions: NoteEntry["regions"],
  all: string,
  intro: boolean
): EntryKind {
  const bare = bareTitleOf(d.title)
  // an item listed under a label reads with it: "deps: content-type@^2.0.0", "types: ..."
  const label = d.headingPath.at(-1)
  const labelled = label ? `${bareTitleOf(label)}: ${bare}` : bare
  const namesCode = regions.some(
    (r) =>
      r.kind === "inline-code" ||
      (r.kind === "code-block" && !INSTALL_COMMAND.test(r.text))
  )
  if (
    [bare, labelled].some((t) => NOISE.test(t) || HOUSEKEEPING.test(t)) ||
    contentless(all, regions) ||
    d.headingPath.some((h) =>
      /^(commits|contributors|new contributors)$/i.test(h.trim())
    ) ||
    (!namesCode && PROJECT_WORK.test(bare))
  )
    return "housekeeping"
  if (TYPES_ONLY.test(bare) || TYPES_ONLY.test(labelled)) return "types"
  if (intro && !namesCode) return "intro"
  if (!namesCode && all.length < 160 && REFERENCE.test(all)) return "reference"
  if (
    ADDITION_TITLE.test(bare) ||
    d.headingPath.some((h) => ADDITION_HEADING.test(h))
  )
    return "addition"
  return "change"
}

// "npm", "[#430]: #430": a link label or a reference with nothing said around it.
function contentless(all: string, regions: NoteEntry["regions"]): boolean {
  if (regions.some((r) => r.kind === "inline-code" || r.kind === "code-block"))
    return false
  const words = all
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(?<![\w/])#\d+\b|\b[0-9a-f]{7,40}\b/g, "")
    .match(/[A-Za-z]{2,}/g)
  return (words?.length ?? 0) < 2
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
        /<\/?(details|summary|p|div|br|sup|sub|b|i|em|strong|span|a|samp)\b[^>]*>/gi,
        " "
      )
      .replace(/&nbsp;/g, " ")
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
