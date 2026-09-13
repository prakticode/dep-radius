// Splits a changelog file into one body per version. Headings come as ATX (`## 1.2.3`) or setext
// (`1.2.3 / 2024-11-06` underlined with `===`), and the version sits anywhere in them:
// `[1.2.3]`, `v1.2.3`, `pkg@1.2.3`, `1.2.3 (2024-01-01)`.

const VERSION_IN_HEADING =
  /(?<![\d.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.])/

interface Heading {
  line: number
  level: number
  text: string
  // lines the heading occupies (setext takes two)
  span: number
}

export function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (atx?.[1] && atx[2]) {
      out.push({ line: i, level: atx[1].length, text: atx[2], span: 1 })
      continue
    }
    const next = lines[i + 1]
    if (
      next !== undefined &&
      line.trim() &&
      !/^\s*([-*+]|\d+\.)\s/.test(line) &&
      !/^\s{4}/.test(line)
    ) {
      if (/^=+\s*$/.test(next))
        out.push({ line: i, level: 1, text: line.trim(), span: 2 })
      else if (/^-{2,}\s*$/.test(next))
        out.push({ line: i, level: 2, text: line.trim(), span: 2 })
    }
  }
  return out
}

export function versionOfHeading(text: string): string | undefined {
  return VERSION_IN_HEADING.exec(text)?.[1]
}

export function changelogSections(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/)
  const headings = headingsOf(lines)
  const sections = new Map<string, string>()
  for (let h = 0; h < headings.length; h++) {
    const head = headings[h]!
    const version = versionOfHeading(head.text)
    if (!version || sections.has(version)) continue
    let end = lines.length
    for (let k = h + 1; k < headings.length; k++) {
      const other = headings[k]!
      if (other.level <= head.level || versionOfHeading(other.text)) {
        end = other.line
        break
      }
    }
    sections.set(
      version,
      lines
        .slice(head.line + head.span, end)
        .join("\n")
        .trim()
    )
  }
  return sections
}
