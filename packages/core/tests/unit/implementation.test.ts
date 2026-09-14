import { describe, expect, it } from "vitest"

import {
  buildImplementationFacts,
  DEFAULT_LIMITS,
  diffImplementations,
  type Flavor,
  flavorFor,
  type ImplementationFacts,
  type Limits,
  reach,
  reachableNames,
  resolveRuntimeEntries,
} from "../../src/facts/implementation/index.ts"

function facts(
  files: Record<string, string>,
  opts: { flavor?: Flavor; limits?: Partial<Limits>; version?: string } = {}
): ImplementationFacts {
  const map = new Map<string, Buffer>(
    Object.entries({
      "package.json": JSON.stringify({ name: "p", main: "index.js" }),
      ...files,
    }).map(([k, v]) => [k, Buffer.from(v)])
  )
  const r = buildImplementationFacts(
    "p",
    opts.version ?? "1.0.0",
    "sha512-x",
    map,
    opts.flavor ?? "require",
    { ...DEFAULT_LIMITS, ...opts.limits }
  )
  if (!r.ok) throw new Error(r.reason)
  return r.facts
}

function changed(
  a: Record<string, string>,
  b: Record<string, string>,
  flavor: Flavor = "require"
) {
  const d = diffImplementations(
    facts(a, { flavor }),
    facts(b, { flavor, version: "1.0.1" })
  )
  return Object.fromEntries(d.changed.map((c) => [c.path, c.units]))
}

function reached(f: ImplementationFacts, path: string): string[] {
  return reach(f, path)
    .map((i) => f.units[i]!.name)
    .sort()
}

describe("fingerprints", () => {
  const before = `
    function greet(name) {
      // say hello
      const message = "hello " + name;
      try { return message } catch (e) { return null }
    }
    module.exports = { greet }
  `

  it("ignore whitespace, comments, semicolons, quotes and renamed locals", () => {
    const after = `
      function greet(person) {
        let text = 'hello ' + person
        try {
          return text
        } catch (_err) {
          return null
        }
      }
      module.exports = { greet, }
    `
    expect(changed({ "index.js": before }, { "index.js": after })).toEqual({})
  })

  it("see a changed literal", () => {
    const after = before.replace('"hello "', '"hi "')
    expect(changed({ "index.js": before }, { "index.js": after })).toEqual({
      "p:greet": ["greet"],
    })
  })

  it("report a change inside a nested function at that function only", () => {
    const code = (limit: number) => `
      function parse(input) {
        function clamp(n) { return Math.min(n, ${limit}) }
        return clamp(input.length)
      }
      module.exports = { parse }
    `
    expect(changed({ "index.js": code(10) }, { "index.js": code(20) })).toEqual(
      { "p:parse": ["parse/clamp"] }
    )
  })

  it("keep property names, which are behaviour, apart from local names", () => {
    const code = (key: string) => `
      function read(options) { const value = 1; return options.${key} }
      module.exports = { read }
    `
    expect(
      changed({ "index.js": code("value") }, { "index.js": code("other") })
    ).toEqual({ "p:read": ["read"] })
  })

  it("read a renamed top-level function in minified code as the same code", () => {
    const filler = Array.from(
      { length: 200 },
      (_, i) => `function f${i}(a){return a+${i}}`
    ).join(";")
    const code = (name: string) =>
      `${filler};function ${name}(a){return a*2}function run(b){return ${name}(b)}exports.run=run;`
    const d = diffImplementations(
      facts({ "index.js": code("q") }),
      facts({ "index.js": code("z") })
    )
    expect(facts({ "index.js": code("q") }).flags).toContain("minified")
    expect(d.changed).toEqual([])
  })
})

describe("the call graph", () => {
  it("follows ESM imports, re-exports and class methods", () => {
    const f = facts(
      {
        "package.json": JSON.stringify({
          name: "p",
          exports: { ".": { import: "./esm/index.mjs" } },
        }),
        "esm/index.mjs": `
          export { persist as keep } from "./middleware.mjs"
          export * from "./store.mjs"
        `,
        "esm/middleware.mjs": `
          import { createStorage } from "./storage.mjs"
          const impl = (config) => {
            const storage = createStorage()
            const hydrate = () => storage.getItem("k")
            return hydrate()
          }
          export const persist = impl
        `,
        "esm/storage.mjs": `
          export function createStorage() {
            return {
              getItem: (name) => localStorage.getItem(name),
              setItem: (name, value) => localStorage.setItem(name, value),
            }
          }
        `,
        "esm/store.mjs": `
          export class Store {
            constructor() { this.state = {} }
            get(key) { return this.read(key) }
            read(key) { return this.state[key] }
            static create() { return new Store() }
          }
        `,
      },
      { flavor: "import" }
    )
    expect(Object.keys(f.exports).sort()).toEqual([
      "p:Store",
      "p:Store#get",
      "p:Store#read",
      "p:Store.create",
      "p:keep",
    ])
    expect(reached(f, "p:keep")).toEqual([
      "createStorage",
      "createStorage/getItem",
      "createStorage/setItem",
      "impl",
      "impl/hydrate",
      "persist",
    ])
    expect(reached(f, "p:Store#get")).toEqual(["Store#get", "Store#read"])
    // `new Store()` then no method called by name: the constructor only
    expect(reached(f, "p:Store.create")).toEqual(["Store", "Store.create"])
    expect(reachableNames(f, "p:keep").called).toContain("setItem")
  })

  it("follows CommonJS: object exports, requires and compiled getters", () => {
    const f = facts({
      "index.js": `
        const parse = require("./lib/parse")
        const util_1 = require("./lib/util")
        Object.defineProperty(exports, "__esModule", { value: true })
        Object.defineProperty(exports, "format", {
          enumerable: true,
          get: function () { return util_1.format },
        })
        module.exports.parse = parse
        exports.stringify = function stringify(v) { return (0, util_1.format)(v) }
      `,
      "lib/parse.js": `
        module.exports = function parse(text) { return split(text) }
        function split(text) { return text.split(",") }
      `,
      "lib/util.js": `
        exports.format = format
        function format(v) { return String(v) }
      `,
    })
    expect(Object.keys(f.exports).sort()).toEqual([
      "p:format",
      "p:parse",
      "p:stringify",
    ])
    expect(reached(f, "p:parse")).toEqual(["exports", "split"])
    expect(reached(f, "p:stringify")).toEqual(["format", "stringify"])
  })

  it("reads `module.exports = require()` and a function with helpers on it", () => {
    const f = facts({
      "index.js": `module.exports = require("./lib/app")`,
      "lib/app.js": `
        exports = module.exports = createApp
        exports.Router = Router
        function createApp() { return new Router() }
        function Router() { this.stack = [] }
        Router.prototype.use = function use(fn) { this.stack.push(fn); return this.handle() }
        Router.prototype.handle = function () { return this.stack.length }
      `,
    })
    expect(Object.keys(f.exports).sort()).toEqual([
      "p:",
      "p:Router",
      "p:Router#handle",
      "p:Router#use",
    ])
    expect(reached(f, "p:")).toEqual(["Router", "createApp"])
    expect(reached(f, "p:Router#use")).toEqual(["Router#handle", "Router#use"])
  })

  it("reads the factory of a UMD bundle", () => {
    const f = facts({
      "index.js": `
        (function (root, factory) {
          if (typeof exports === "object") module.exports = factory()
          else root.Lib = factory()
        })(this, function () {
          function CsvToJson(input) { return input.split("\\n") }
          function JsonToCsv(rows) { return rows.join("\\n") }
          var Lib = {}
          Lib.parse = CsvToJson
          Lib.unparse = JsonToCsv
          return Lib
        })
      `,
    })
    expect(Object.keys(f.exports).sort()).toEqual([
      "p:",
      "p:parse",
      "p:unparse",
    ])
    expect(reached(f, "p:parse")).toEqual(["CsvToJson"])
  })

  it("gives a class handed on as a value all its methods", () => {
    const f = facts(
      {
        "package.json": JSON.stringify({ name: "p", module: "index.mjs" }),
        "index.mjs": `
          class Action { schedule() { return 1 } recycle() { return 2 } }
          class Scheduler { constructor(ctor) { this.ctor = ctor } }
          export const asap = new Scheduler(Action)
        `,
      },
      { flavor: "import" }
    )
    expect(reached(f, "p:asap")).toEqual([
      "Action",
      "Action#recycle",
      "Action#schedule",
      "Scheduler",
      "asap",
    ])
  })

  it("links a method called on an unknown value to the few methods of that name", () => {
    const code = (candidates: number) => `
      ${Array.from({ length: candidates }, (_, i) => `class C${i} { flush() { return ${i} } }`).join("\n")}
      export function run(queue) { return queue.flush() }
    `
    const pj = JSON.stringify({ name: "p", module: "index.mjs" })
    const few = facts(
      { "package.json": pj, "index.mjs": code(2) },
      { flavor: "import" }
    )
    expect(reached(few, "p:run")).toEqual(["C0#flush", "C1#flush", "run"])
    const many = facts(
      { "package.json": pj, "index.mjs": code(5) },
      { flavor: "import" }
    )
    expect(reached(many, "p:run")).toEqual(["run"])
  })
})

describe("diffImplementations", () => {
  it("names the exports whose reachable code changed, and the units inside", () => {
    const storage = (write: string) => `
      function createStorage() {
        return { setItem: (k, v) => localStorage.setItem(k, v) }
      }
      function persist(config) {
        const storage = createStorage()
        const hydrate = () => { ${write} }
        hydrate()
        return config
      }
      function combine(a, b) { return Object.assign({}, a, b) }
      module.exports = { persist, combine, createStorage }
    `
    const before = { "index.js": storage("storage.setItem('k', 1)") }
    const after = { "index.js": storage("if (false) storage.setItem('k', 1)") }
    const d = diffImplementations(facts(before), facts(after))
    expect(d.changed).toEqual([
      { path: "p:persist", units: ["persist/hydrate"] },
    ])
    expect(d.unchanged).toBe(2)
    expect(d.changedUnits).toEqual(["persist/hydrate"])
    expect(reachableNames(facts(before), "p:persist").called).toContain(
      "setItem"
    )
  })

  it("lists exports that come and go apart from changed ones", () => {
    const d = diffImplementations(
      facts({ "index.js": "exports.a = function () {}" }),
      facts({ "index.js": "exports.b = function () {}" })
    )
    expect(d).toMatchObject({ added: ["p:b"], removed: ["p:a"], changed: [] })
  })

  it("gives the same facts for the same files", () => {
    const files = {
      "index.js": `
        const a = require("./a"); const b = require("./b")
        module.exports = { run: () => a.x() + b.y() }
      `,
      "a.js": "exports.x = () => require('./b').y()",
      "b.js": "exports.y = () => 1",
    }
    expect(JSON.stringify(facts(files))).toBe(JSON.stringify(facts(files)))
  })
})

describe("limits", () => {
  const files = {
    "index.js": "exports.a = require('./a').a",
    "a.js": "exports.a = function a() { return require('./b').b() }",
    "b.js": "exports.b = function b() { return 1 }",
  }

  it("stops at the file cap and says so", () => {
    const f = facts(files, { limits: { files: 2 } })
    expect(f.files).toBe(2)
    expect(f.flags).toContain("file-cap")
  })

  it("stops at the work cap and says so", () => {
    expect(facts(files, { limits: { work: 10 } }).flags).toContain("work-cap")
  })
})

describe("runtime entries", () => {
  it("takes conditions in the order the export map lists them", () => {
    const pj = {
      exports: {
        ".": { node: "./dist/index.js", default: "./browser/index.js" },
        "./util": { import: "./esm/util.mjs", require: "./cjs/util.js" },
      },
    }
    const files = [
      "dist/index.js",
      "browser/index.js",
      "esm/util.mjs",
      "cjs/util.js",
    ]
    expect(resolveRuntimeEntries(pj, files, "require").entries).toEqual([
      { subpath: ".", file: "dist/index.js" },
      { subpath: "./util", file: "cjs/util.js" },
    ])
    expect(resolveRuntimeEntries(pj, files, "import").entries).toEqual([
      { subpath: ".", file: "dist/index.js" },
      { subpath: "./util", file: "esm/util.mjs" },
    ])
  })

  it("reads ESM only when both versions publish it", () => {
    const cjs = { main: "index.js" }
    const esm = { exports: { import: "./index.mjs", require: "./index.js" } }
    expect(flavorFor(esm, esm)).toBe("import")
    expect(flavorFor(cjs, esm)).toBe("require")
  })
})
