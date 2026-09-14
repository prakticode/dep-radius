// Builds change records with a model, offline: never part of a radius run. For each note entry that
// describes a change, the model reads the entry's own text and a list of the package's real APIs
// (the symbols of both versions' type surfaces and the options they take), and picks the APIs the
// change is about. Every answer is checked against that list and the surfaces, each entry is asked
// twice, and an entry whose two answers differ, or that the model is unsure about, keeps no
// subjects: the note stays one radius cannot tie, as it is without records.
//
//   node scripts/records-ai.ts <name> <from> <to> [--out <dir>] [--max-calls 300] [--cache <dir>]
//
// With ANTHROPIC_API_KEY set, it calls the Messages API; otherwise the Claude Code CLI, headless.
// Every call is kept on disk by prompt, model and run, so a second pass costs nothing.

import { tmpdir } from "node:os"
import { parseArgs } from "node:util"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"

import { createCtx } from "../src/context.ts"
import { createLimiter } from "../src/infra/limit.ts"
import { collectNotes } from "../src/notes/collect.ts"
import { defaultCacheDir } from "../src/infra/cache.ts"
import { recordFileName } from "../src/records/load.ts"
import type { NoteEntry, Surface } from "../src/model.ts"
import { extractSurface } from "../src/surface/extract.ts"
import { getPackument } from "../src/registry/packument.ts"
import { lastName, parsePath } from "../src/symbol-path.ts"
import { validateRecords } from "../src/records/validate.ts"
import { loadRegistryConfig } from "../src/registry/npmrc.ts"
import { selectCandidate } from "../src/registry/candidates.ts"
import {
  type ChangeRecord,
  formatSubject,
  RECORD_SCHEMA,
} from "../src/records/record.ts"

export const MODEL = "claude-sonnet-5"
// bump when the prompt or the candidate list changes: records say which prompt made them
export const PROMPT_VERSION = "1"
const CANDIDATE_CAP = 150
const RUNS = 2

export interface Surfaces {
  from: Surface
  to: Surface
}

// ---------------------------------------------------------------- what the model sees

// The entry as the notes write it: its section, its words, its code.
export function entryText(e: NoteEntry): string {
  const out: string[] = []
  if (e.headingPath.length > 0)
    out.push(`Section: ${e.headingPath.join(" > ")}`)
  let line = ""
  for (const r of e.regions) {
    if (r.kind === "code-block") {
      if (line.trim()) out.push(line.trim())
      line = ""
      out.push("```", r.text, "```")
    } else if (r.kind === "inline-code") line += ` \`${r.text}\` `
    else line += r.kind === "prose" && line ? `\n${r.text}` : r.text
  }
  if (line.trim()) out.push(line.trim())
  return out.join("\n").replace(/[ \t]+/g, " ")
}

function words(text: string): string[] {
  return (text.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3)
}

function related(a: string, b: string): boolean {
  if (a === b) return true
  const n = Math.min(a.length, b.length)
  return n >= 5 && a.slice(0, n - 1) === b.slice(0, n - 1)
}

// Every API of both versions, and the options each one takes, as the subjects a record may name.
// The list is cut to what the entry could be about: the APIs and options whose words the entry
// uses, then the main entry's exports and what they take, then the rest; private-looking names
// (`_remove`, `#0`) last. Up to the cap, sorted.
export function candidatesFor(
  e: NoteEntry,
  surfaces: Surfaces,
  cap = CANDIDATE_CAP
): string[] {
  const all = new Map<string, { rank: number; depth: number }>()
  // a tuple or array type lists every array method as its own member
  const arrayLike = new Set(
    [surfaces.from, surfaces.to].flatMap((s) =>
      Object.keys(s.symbols)
        .filter(
          (p) => p.endsWith("#push") && s.symbols[`${p.slice(0, -5)}#slice`]
        )
        .map((p) => p.slice(0, -5))
    )
  )
  const text = words(entryText(e))
  const mentioned = (name: string) =>
    words(name).some((w) => text.some((t) => related(w, t))) ||
    text.includes(name.toLowerCase())
  const add = (subject: string, path: string, name: string) => {
    const { prefix, segs } = parsePath(path)
    const main = prefix === surfaces.to.pkg
    const parent = path.slice(0, Math.max(path.lastIndexOf("#"), 0))
    const hidden =
      [...segs.map((s) => s.name), name].some((n) => /^(_|\d+$)/.test(n)) ||
      arrayLike.has(parent)
    const place = main ? (segs.length === 1 ? 1 : 2) : segs.length === 1 ? 3 : 4
    const rank = (hidden ? 10 : 0) + (mentioned(name) ? 0 : place)
    const prev = all.get(subject)
    if (!prev || rank < prev.rank)
      all.set(subject, { rank, depth: segs.length })
  }
  for (const s of [surfaces.from, surfaces.to])
    for (const sym of Object.values(s.symbols)) {
      add(sym.path, sym.path, lastName(sym.path))
      for (const option of sym.options ?? [])
        add(formatSubject(sym.path, option), sym.path, option)
    }
  return [...all.entries()]
    .sort(
      ([a, x], [b, y]) =>
        x.rank - y.rank || x.depth - y.depth || (a < b ? -1 : 1)
    )
    .slice(0, cap)
    .map(([subject]) => subject)
    .sort()
}

export function promptFor(e: NoteEntry, candidates: string[]): string {
  return `One entry of a JavaScript package's release notes, and a list of the package's APIs.

Entry:
<<<
${entryText(e)}
>>>

APIs, as exact strings. "path{name}" is the option "name" of what "path" takes (an options object
passed to that function or constructor); "#" is an instance member, "." a static member:
${candidates.map((c) => `- ${c}`).join("\n")}

Which of these APIs does the change affect: code calling them, or passing that option, may behave
differently after the upgrade? An entry may describe several changes: name the APIs of each one.
Answer with one JSON object and nothing else:
{"subjects": [...], "what": "...", "unsure": false}

- subjects: strings copied exactly from the list. Name the most specific ones: the option when the
  change is about an option, the member when it is about a member. Only APIs the entry is about,
  not APIs it merely shows in an example.
- If the entry is not about specific APIs in the list (a platform, a dependency, internal work,
  something every caller gets), or you cannot tell, answer "subjects": [] and "unsure": true.
- what: what changes for code that uses those APIs, in at most 20 words.`
}

const SYSTEM =
  "You classify release notes. You answer with a single JSON object, no prose, no code fence."

export interface Answer {
  subjects: string[]
  // what the model named that is not in the list
  rejected: string[]
  what: string
  unsure: boolean
}

// An answer is JSON with the three fields; a subject not copied from the list is dropped.
export function parseAnswer(
  text: string,
  allowed: Set<string>
): Answer | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== "object") return undefined
  const a = raw as Record<string, unknown>
  if (!Array.isArray(a.subjects)) return undefined
  const named = a.subjects.filter((s): s is string => typeof s === "string")
  return {
    subjects: [...new Set(named.filter((s) => allowed.has(s)))].sort(),
    rejected: named.filter((s) => !allowed.has(s)),
    what: typeof a.what === "string" ? a.what.slice(0, 200) : "",
    unsure: a.unsure === true,
  }
}

// ---------------------------------------------------------------- calling a model

export type Backend = (prompt: string, model: string) => Promise<string>

export function defaultBackend(env: NodeJS.ProcessEnv): {
  name: string
  call: Backend
} {
  const key = env.ANTHROPIC_API_KEY
  return key
    ? { name: "api", call: (p, m) => callApi(key, p, m) }
    : { name: "claude-cli", call: callCli }
}

async function callApi(
  key: string,
  prompt: string,
  model: string
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!res.ok)
    throw new Error(`api: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as {
    content?: { type: string; text?: string }[]
  }
  return (body.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
}

// `claude -p` with no tools, no session kept, from an empty folder so no project file is read.
async function callCli(prompt: string, model: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "records-ai-"))
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM,
  ]
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000)
    child.stdout.on("data", (d: Buffer) => (out += d.toString()))
    child.stderr.on("data", (d: Buffer) => (err += d.toString()))
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`))
    })
    child.stdin.end(prompt)
  })
  const result = JSON.parse(stdout) as { is_error?: boolean; result?: string }
  if (result.is_error || typeof result.result !== "string")
    throw new Error(`claude: ${stdout.slice(0, 200)}`)
  return result.result
}

// ---------------------------------------------------------------- records

export interface ExtractOptions {
  backend: Backend
  model?: string
  cacheDir: string
  // model calls not already on disk; entries past the budget get no record
  maxCalls: number
  concurrency?: number
  log?: (line: string) => void
}

export interface EntryOutcome {
  entry: NoteEntry
  candidates: number
  runs: Answer[]
  agreed: boolean
  record?: ChangeRecord
}

export async function extractRecords(
  pkg: string,
  entries: NoteEntry[],
  surfaces: Surfaces,
  options: ExtractOptions
): Promise<{ outcomes: EntryOutcome[]; freshCalls: number }> {
  const model = options.model ?? MODEL
  const limit = createLimiter(options.concurrency ?? 4)
  let fresh = 0
  const ask = async (
    prompt: string,
    run: number
  ): Promise<string | undefined> => {
    const key = createHash("sha256")
      .update(`${model}\0${run}\0${prompt}`)
      .digest("hex")
    const file = join(options.cacheDir, "calls", `${key}.json`)
    try {
      return (JSON.parse(await readFile(file, "utf8")) as { text: string }).text
    } catch {
      // not asked yet
    }
    if (fresh >= options.maxCalls) return undefined
    fresh++
    let text: string | undefined
    for (let attempt = 0; attempt < 2 && text === undefined; attempt++)
      try {
        text = await options.backend(prompt, model)
      } catch (error) {
        options.log?.(`  call failed: ${String(error).slice(0, 160)}`)
      }
    if (text === undefined) return undefined
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ model, run, prompt, text }))
    return text
  }

  const outcomes = await Promise.all(
    entries.map((entry) =>
      limit(async (): Promise<EntryOutcome> => {
        const candidates = candidatesFor(entry, surfaces)
        const allowed = new Set(candidates)
        const prompt = promptFor(entry, candidates)
        const texts: (string | undefined)[] = []
        for (let run = 1; run <= RUNS; run++) texts.push(await ask(prompt, run))
        if (texts.some((t) => t === undefined))
          return {
            entry,
            candidates: candidates.length,
            runs: [],
            agreed: false,
          }
        const runs = texts.map(
          (t) =>
            parseAnswer(t!, allowed) ?? {
              subjects: [],
              rejected: [],
              what: "",
              unsure: true,
            }
        )
        const same = runs.every(
          (r) =>
            JSON.stringify(r.subjects) === JSON.stringify(runs[0]!.subjects)
        )
        const sure = runs.every((r) => !r.unsure)
        const record: ChangeRecord = {
          schema: RECORD_SCHEMA,
          entry: entry.id,
          version: entry.version,
          kind: entry.kind,
          breaking: entry.breakingMarker,
          subjects: same && sure ? runs[0]!.subjects : [],
          what: runs[0]!.what,
          source: "ai",
          confidence: same && sure ? 1 : 0,
          extractor: `ai:${model}:prompt-${PROMPT_VERSION}`,
          provenance: {
            runs: runs.map((r) => ({ subjects: r.subjects, unsure: r.unsure })),
            candidates: candidates.length,
            surfaces: {
              from: `${pkg}@${surfaces.from.version}`,
              to: `${pkg}@${surfaces.to.version}`,
            },
          },
        }
        const [valid] = validateRecords([record], [entry], surfaces)
        return {
          entry,
          candidates: candidates.length,
          runs,
          agreed: same,
          ...(valid ? { record: valid } : {}),
        }
      })
    )
  )
  return { outcomes, freshCalls: fresh }
}

// One file per version, the records sorted by entry: the directory a run reads with recordsDir.
export async function writeRecords(
  dir: string,
  pkg: string,
  records: ChangeRecord[]
): Promise<string[]> {
  const byVersion = new Map<string, ChangeRecord[]>()
  for (const r of records)
    byVersion.set(r.version, [...(byVersion.get(r.version) ?? []), r])
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const [version, list] of [...byVersion].sort()) {
    const file = join(dir, recordFileName(pkg, version))
    list.sort((a, b) => (a.entry < b.entry ? -1 : 1))
    await writeFile(file, `${JSON.stringify(list, null, 2)}\n`)
    written.push(file)
  }
  return written
}

// The entries a record can help: changes and breaks, never housekeeping or additions.
export function wantsRecord(e: NoteEntry): boolean {
  return !e.noise && (e.kind === "change" || e.breakingMarker)
}

// ---------------------------------------------------------------- command

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      cache: { type: "string" },
      "max-calls": { type: "string" },
      model: { type: "string" },
    },
  })
  const [name, from, to] = positionals
  if (!name || !from || !to)
    throw new Error("usage: records-ai.ts <name> <from> <to> [--out <dir>]")
  const cacheDir = defaultCacheDir(process.env)
  const ctx = createCtx({
    root: process.cwd(),
    specs: [],
    format: "json",
    offline: false,
    minAgeMs: 0,
    latest: false,
    notes: true,
    surface: true,
    prod: false,
    concurrency: 8,
    cacheDir,
    verbose: false,
    now: Date.now(),
    color: false,
  })
  const cfg = loadRegistryConfig(process.cwd(), process.env)
  const pack = await getPackument(ctx, cfg, name)
  if (!pack.ok) throw new Error(`registry: ${pack.reason}`)
  const choice = selectCandidate(pack.packument, from, {
    now: ctx.now,
    minAgeMs: 0,
    ageExcluded: () => true,
    latest: false,
    explicit: to,
  })
  if (choice.kind !== "candidate")
    throw new Error(`no upgrade ${from} -> ${to}`)
  const [notes, a, b] = await Promise.all([
    collectNotes(ctx, cfg, pack.packument, choice.candidate),
    extractSurface(ctx, cfg, pack.packument, from),
    extractSurface(ctx, cfg, pack.packument, to),
  ])
  if (!a.ok || !b.ok)
    throw new Error("the type surface of both versions is needed")
  const backend = defaultBackend(process.env)
  const { outcomes, freshCalls } = await extractRecords(
    name,
    notes.entries.filter(wantsRecord),
    { from: a.surface, to: b.surface },
    {
      backend: backend.call,
      ...(values.model ? { model: values.model } : {}),
      cacheDir: values.cache ?? join(cacheDir, "records-ai"),
      maxCalls: Number(values["max-calls"] ?? 300),
      log: (line) => console.error(line),
    }
  )
  const records = outcomes.flatMap((o) => (o.record ? [o.record] : []))
  const out = values.out ?? join(cacheDir, "records")
  for (const file of await writeRecords(out, name, records)) console.log(file)
  console.error(
    `${records.length} records, ${records.filter((r) => r.subjects.length > 0).length} with subjects, ${freshCalls} calls through ${backend.name}`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
