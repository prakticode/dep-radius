import { join } from "node:path"
import { readFile } from "node:fs/promises"

import { SKIP_DIRS } from "../inventory/manifests.ts"

export const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i
export const STYLE_EXT = /\.(?:css|scss|sass|less|pcss|postcss)$/i

export interface SourceText {
  rel: string
  // each block is parsed on its own; lineOffset maps its lines back to the file
  blocks: {
    text: string
    lineOffset: number
    kind: "ts" | "tsx" | "js" | "jsx"
  }[]
}

export type Skip = { rel: string; reason: "generated" | "too-large" }

const MAX_BYTES = 1_500_000

export function isScannable(rel: string): boolean {
  if (!SOURCE_EXT.test(rel)) return false
  const segs = rel.split("/")
  return !segs.slice(0, -1).some((s) => SKIP_DIRS.has(s))
}

export function skippedByLocation(rel: string): boolean {
  return (
    SOURCE_EXT.test(rel) &&
    rel
      .split("/")
      .slice(0, -1)
      .some((s) => SKIP_DIRS.has(s) && s !== "node_modules")
  )
}

export async function readSource(
  root: string,
  rel: string
): Promise<SourceText | Skip> {
  const buf = await readFile(join(root, rel))
  if (buf.byteLength > MAX_BYTES) return { rel, reason: "too-large" }
  const text = buf.toString("utf8")
  if (looksMinified(text)) return { rel, reason: "generated" }
  const lower = rel.toLowerCase()

  if (lower.endsWith(".vue") || lower.endsWith(".svelte")) {
    const blocks: SourceText["blocks"] = []
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const attrs = m[1] ?? ""
      const body = m[2] ?? ""
      const start = m.index + m[0].indexOf(">") + 1
      const ts = /\blang\s*=\s*["']?(ts|tsx)/i.test(attrs)
      blocks.push({
        text: body,
        lineOffset: lineOf(text, start) - 1,
        kind: ts ? "ts" : "js",
      })
    }
    return { rel, blocks }
  }
  if (lower.endsWith(".astro")) {
    const blocks: SourceText["blocks"] = []
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (fm?.[1] !== undefined)
      blocks.push({ text: fm[1], lineOffset: 1, kind: "ts" })
    const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index + m[0].indexOf(">") + 1
      blocks.push({
        text: m[1] ?? "",
        lineOffset: lineOf(text, start) - 1,
        kind: "ts",
      })
    }
    return { rel, blocks }
  }
  const kind = /\.[cm]?tsx$/i.test(lower)
    ? "tsx"
    : /\.[cm]?ts$/i.test(lower)
      ? "ts"
      : /\.jsx$/i.test(lower)
        ? "jsx"
        : "js"
  return { rel, blocks: [{ text, lineOffset: 0, kind }] }
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

// Bundles and minified output have very long lines; reading them as source would invent usage.
function looksMinified(text: string): boolean {
  if (text.length < 5000) return false
  const lines = text.split("\n")
  const long = lines.filter((l) => l.length > 1000).length
  return long > 0 && text.length / lines.length > 300
}
