import ts from "typescript"
import { describe, expect, it } from "vitest"

import { parseSource } from "../../src/usage/parse.ts"

function facts(text: string, kind: "ts" | "tsx" | "js" = "ts") {
  return parseSource({ rel: "f.ts", blocks: [{ text, lineOffset: 0, kind }] })
}

function refs(text: string, kind: "ts" | "tsx" | "js" = "ts") {
  return facts(text, kind).references.map((r) => ({
    local: r.local,
    chain: r.chain.map((c) => c.name + (c.call ? "()" : "")).join("."),
    callSelf: r.callSelf,
    escape: r.escape,
    typeOnly: r.typeOnly,
    ...(r.derivedInto ? { derivedInto: r.derivedInto } : {}),
  }))
}

describe("parse: bindings", () => {
  it("reads every ESM import form", () => {
    const f = facts(`
      import d, { a, b as c, default as e } from "p"
      import * as ns from "q"
      import type { T } from "r"
      import "side"
      import x = require("cjs")
    `)
    expect(
      f.imports.map((i) => [i.local, i.specifier, i.binding, i.typeOnly])
    ).toEqual([
      ["d", "p", { kind: "default" }, false],
      ["a", "p", { kind: "named", imported: "a" }, false],
      ["c", "p", { kind: "named", imported: "b" }, false],
      ["e", "p", { kind: "default" }, false],
      ["ns", "q", { kind: "namespace" }, false],
      ["T", "r", { kind: "named", imported: "T" }, true],
      ["x", "cjs", { kind: "cjs" }, false],
    ])
    expect(f.sideEffects.map((s) => s.specifier)).toEqual(["side"])
  })

  it("reads CommonJS and awaited dynamic imports, at any depth", () => {
    const f = facts(
      `
      const express = require("express")
      const { template, map: m } = require("lodash")
      async function f() { const { v } = await import("schemakit"); const mod = await import("m") }
      require("dotenv/config")
    `,
      "js"
    )
    expect(
      f.imports.map((i) => [i.local, i.specifier, i.binding.kind])
    ).toEqual([
      ["express", "express", "cjs"],
      ["template", "lodash", "named"],
      ["m", "lodash", "named"],
      ["v", "schemakit", "named"],
      ["mod", "m", "namespace"],
    ])
    expect(f.sideEffects.map((s) => s.specifier)).toEqual(["dotenv/config"])
  })

  it("counts non-literal loaders and keeps static prefixes", () => {
    const f = facts("require(name); import(x); import(`schemakit/${y}`)", "js")
    expect(f.nonLiteralRequire).toHaveLength(1)
    expect(f.nonLiteralImport).toHaveLength(1)
    expect(f.prefixImports.map((p) => p.prefix)).toEqual(["schemakit/"])
  })

  it("reads re-exports", () => {
    const f = facts(`
      export * from "schemakit"
      export { a, b as c } from "p"
      export * as ns from "q"
      import * as v from "schemakit"
      export { v }
      export const email = v.email()
      export function local() {}
    `)
    expect(f.reExports.map((r) => [r.kind, r.specifier, r.names])).toEqual([
      ["star", "schemakit", []],
      [
        "named",
        "p",
        [
          { imported: "a", exported: "a" },
          { imported: "b", exported: "c" },
        ],
      ],
      ["star-as", "q", [{ imported: "*", exported: "ns" }]],
    ])
    expect(f.exportedLocals).toEqual([{ local: "v", exported: "v" }])
    expect(f.declaredExports).toEqual(["email", "local"])
  })
})

describe("parse: keys passed to calls", () => {
  it("records the keys of object literals passed along a chain, by the reference", () => {
    const f = facts(`
      const bodyParser = require("body-parser")
      app.use(bodyParser.json({ limit: max, "type": "json" }))
      const pool = new Pool({ ssl, [computed]: 1, ...rest })
      bodyParser.text()
    `)
    expect(f.passedKeys).toEqual([
      { line: 3, col: 15, keys: ["limit", "type"] },
    ])
  })
})

describe("parse: references", () => {
  it("climbs member chains and marks the first call", () => {
    expect(
      refs(
        `import * as v from "schemakit"; const s = v.email().max(254); v.coerce.number()`
      )
    ).toEqual([
      {
        local: "v",
        chain: "email().max()",
        callSelf: false,
        escape: false,
        typeOnly: false,
        derivedInto: "s",
      },
      {
        local: "v",
        chain: "coerce.number()",
        callSelf: false,
        escape: false,
        typeOnly: false,
      },
    ])
  })

  it("reads type positions as type-only", () => {
    expect(
      refs(
        `import * as v from "schemakit"; type A = v.infer<typeof s>; let b: typeof v.email`
      )
    ).toEqual([
      {
        local: "v",
        chain: "infer",
        callSelf: false,
        escape: false,
        typeOnly: true,
      },
      {
        local: "v",
        chain: "email",
        callSelf: false,
        escape: false,
        typeOnly: true,
      },
    ])
  })

  it("flags a namespace handed away, never a named import", () => {
    expect(
      refs(
        `import * as v from "schemakit"; import { a } from "p"; use(v); use(a)`
      )
    ).toEqual([
      { local: "v", chain: "", callSelf: false, escape: true, typeOnly: false },
      {
        local: "a",
        chain: "",
        callSelf: false,
        escape: false,
        typeOnly: false,
      },
    ])
  })

  it("follows derived values as their own references", () => {
    const r = refs(
      `const express = require("express"); const app = express(); app.use(express.json())`,
      "js"
    )
    expect(r).toEqual([
      {
        local: "express",
        chain: "",
        callSelf: true,
        escape: false,
        typeOnly: false,
        derivedInto: "app",
      },
      {
        local: "express",
        chain: "json()",
        callSelf: false,
        escape: false,
        typeOnly: false,
      },
      {
        local: "app",
        chain: "use()",
        callSelf: false,
        escape: false,
        typeOnly: false,
      },
    ])
  })

  it("treats JSX tags and class heritage as uses, not escapes", () => {
    expect(
      refs(
        `import Button, * as UI from "ui"; const a = <Button/>; const b = <UI.Card/>`,
        "tsx"
      )
    ).toEqual([
      {
        local: "Button",
        chain: "",
        callSelf: true,
        escape: false,
        typeOnly: false,
      },
      {
        local: "UI",
        chain: "Card()",
        callSelf: false,
        escape: false,
        typeOnly: false,
      },
    ])
  })

  it("never reads names from comments or strings", () => {
    const f = facts(
      `import * as v from "schemakit"\n// never through v.config()\nconst s = "every v.string() here"`
    )
    expect(f.references).toEqual([])
    expect(f.stringLiterals.map((s) => s.value)).toEqual([
      "every v.string() here",
    ])
  })

  it("does not count property names or declarations that share an import's name", () => {
    expect(
      refs(
        `import { email } from "p"; const o = { email: 1 }; o.email; function f(email2) {}`
      )
    ).toEqual([])
  })

  it("reads inline require chains", () => {
    const f = facts(`const t = require("lodash").template(s)`, "js")
    expect(
      f.inline.map((i) => [i.specifier, i.chain.map((c) => c.name).join(".")])
    ).toEqual([["lodash", "template"]])
  })

  it("exposes parseDiagnostics on the pinned TypeScript", () => {
    const sf = ts.createSourceFile(
      "x.ts",
      "const = ",
      ts.ScriptTarget.Latest,
      true
    )
    expect(
      (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length
    ).toBeGreaterThan(0)
    expect(facts("const = ").unparseable).toBe(true)
  })
})
