import { join, relative } from "node:path"
import { readdirSync, readFileSync } from "node:fs"

import ts from "typescript"
import { describe, expect, it } from "vitest"

// A rule written for one benchmark package scores on the benchmark and nowhere else. Core reads
// facts about packages and notes in general, so no string or regex in src names a case's package.

const CORE = join(import.meta.dirname, "../..")
const CASES = join(CORE, "tests/benchmark/cases")

function benchmarkPackages(): string[] {
  const names = readdirSync(CASES).map(
    (c) =>
      (
        JSON.parse(readFileSync(join(CASES, c, "case.json"), "utf8")) as {
          package: string
        }
      ).package
  )
  // core names its own dependencies in messages: "installed version 1.x is not semver"
  const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
  }
  const own = new Set(Object.keys(pkg.dependencies ?? {}))
  return [...new Set(names)].filter((n) => !own.has(n))
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : []
  )
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

function packageNamesIn(file: string, text: string, names: string[]): string[] {
  const patterns = names.map((n) => ({
    name: n,
    re: new RegExp(`(^|[^\\w@./-])${escape(n)}($|[^\\w/-])`),
  }))
  const found: string[] = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    // the packages core itself depends on are imported by name
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      for (const p of patterns)
        if (p.re.test(node.text)) found.push(`${line} ${p.name}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("core source", () => {
  it("never names a benchmark package in a string or regex", () => {
    const names = benchmarkPackages()
    expect(names.length).toBeGreaterThan(0)
    const found = sourceFiles(join(CORE, "src")).flatMap((f) =>
      packageNamesIn(f, readFileSync(f, "utf8"), names).map(
        (hit) => `${relative(CORE, f)}:${hit}`
      )
    )
    expect(found).toEqual([])
  })

  it("catches a package name in a string or a regex", () => {
    const text = `const a = "zod"\nconst b = /^axios\\b/\nimport semver from "semver"\nconst c = "zodiac"`
    expect(packageNamesIn("x.ts", text, ["zod", "axios", "semver"])).toEqual([
      "1 zod",
      "2 axios",
    ])
  })
})
