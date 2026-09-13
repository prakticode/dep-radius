import { join } from "node:path"
import { readdirSync, readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

// written as a code point, so this file passes its own check
const EM_DASH = String.fromCodePoint(0x2014)
const app = join(import.meta.dirname, "..")
const repo = join(app, "../..")

function filesUnder(dir: string, accept: RegExp): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && accept.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}

const pages = filesUnder(join(app, "content"), /\.mdx?$/)
const read = (file: string) => readFileSync(file, "utf8")
const allPages = pages.map(read).join("\n")

describe("the docs content", () => {
  it("contains no em dash, in the pages or in the site code", () => {
    const written = [
      ...pages,
      ...["app", "components", "lib"].flatMap((d) =>
        filesUnder(join(app, d), /\.(tsx?|css|json)$/)
      ),
    ]
    const offenders = written.filter((f) => read(f).includes(EM_DASH))
    expect(offenders.map((f) => f.slice(app.length + 1))).toEqual([])
  })

  it("gives every page a title and a description", () => {
    const missing = pages.filter((f) => {
      const front = /^---\n([\s\S]*?)\n---/.exec(read(f))?.[1] ?? ""
      return !/^title: .+/m.test(front) || !/^description: .+/m.test(front)
    })
    expect(missing).toEqual([])
  })

  it("quotes a frontmatter value that holds a colon, which YAML would read as a mapping", () => {
    const unquoted = pages.filter((f) =>
      /^[a-z]+: [^"'\n]*: /m.test(
        /^---\n([\s\S]*?)\n---/.exec(read(f))?.[1] ?? ""
      )
    )
    expect(unquoted).toEqual([])
  })

  it("documents every option of the CLI", () => {
    const cli = read(join(repo, "packages/cli/src/cli.ts"))
    const declared = /options: \{([\s\S]*?)\n {6}\},/.exec(cli)?.[1] ?? ""
    const options = [...declared.matchAll(/^ {8}"?([a-z-]+)"?: \{/gm)]
      .map((m) => m[1]!)
      // --now only pins the clock for tests and backtests
      .filter((name) => name !== "now")
    expect(options.length).toBeGreaterThan(10)
    const cliPage = read(join(app, "content/docs/cli.mdx"))
    const undocumented = options.filter(
      (name) =>
        !cliPage.includes(`\`--${name}`) && !cliPage.includes(`\`--no-${name}`)
    )
    expect(undocumented).toEqual([])
  })

  it("documents every input and output of the GitHub Action", () => {
    const action = read(join(repo, "action.yml"))
    const section = (name: string) =>
      new RegExp(`^${name}:\\n((?: {2}.*\\n|\\n)*)`, "m").exec(action)?.[1] ??
      ""
    const keys = (block: string) =>
      [...block.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]!)
    const names = [...keys(section("inputs")), ...keys(section("outputs"))]
    expect(names.length).toBeGreaterThan(8)
    const page = read(join(app, "content/docs/github-action.mdx"))
    expect(names.filter((n) => !page.includes(`| \`${n}\``))).toEqual([])
  })

  it("links only to pages that exist", () => {
    const slugs = new Set(
      pages.map((f) =>
        f
          .slice(join(app, "content/docs").length)
          .replace(/\.mdx?$/, "")
          .replace(/\/index$/, "")
      )
    )
    const links = [...allPages.matchAll(/\]\(\/docs([^)#\s]*)/g)].map(
      (m) => m[1]!
    )
    const hrefs = [...allPages.matchAll(/href="\/docs([^"#]*)"/g)].map(
      (m) => m[1]!
    )
    const broken = [...links, ...hrefs].filter((l) => !slugs.has(l))
    expect(broken).toEqual([])
  })
})
