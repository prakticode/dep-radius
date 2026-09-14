import { describe, expect, it } from "vitest"

import { packTarball } from "../helpers/pack.ts"
import { build } from "../../src/surface/extract.ts"
import { resolveRef } from "../../src/symbol-path.ts"
import { readTarball } from "../../src/registry/tar.ts"
import type { RawRef, Surface } from "../../src/model.ts"
import { diffSurfaces } from "../../src/surface/delta.ts"

function surface(
  dts: string,
  pj: Record<string, unknown> = { name: "p", types: "index.d.ts" },
  extra: Record<string, string> = {}
): Surface {
  const files = new Map<string, Buffer>([
    ["package.json", Buffer.from(JSON.stringify(pj))],
    ["index.d.ts", Buffer.from(dts)],
    ...Object.entries(extra).map(
      ([k, v]) => [k, Buffer.from(v)] as [string, Buffer]
    ),
  ])
  const r = build(String(pj.name), "1.0.0", "sha512-x", files)
  if (!r.ok) throw new Error(r.reason)
  return r.surface
}

function counts(a: string, b: string) {
  const d = diffSurfaces(surface(a), surface(b))
  return {
    removed: d.removed.map((c) => c.path),
    unproven: d.unproven.map((c) => `${c.cause} ${c.path}`),
    changed: d.changed.map((c) => c.path),
    widened: d.widened.map((c) => c.path),
    deprecated: d.deprecated.map((c) => c.path),
    added: d.added.map((c) => c.path),
  }
}

const none = {
  removed: [],
  unproven: [],
  changed: [],
  widened: [],
  deprecated: [],
  added: [],
}

describe("surface delta", () => {
  it("finds a removed export", () => {
    expect(
      counts(
        "export declare function a(): void\nexport declare function b(): void",
        "export declare function a(): void"
      )
    ).toEqual({ ...none, removed: ["p:b"] })
  })

  it("ignores renamed parameters and reordered unions", () => {
    expect(
      counts(
        "export declare function f(value: string | number): void",
        "export declare function f(input: number | string): void"
      )
    ).toEqual(none)
    expect(
      counts(
        "export declare function g<T>(x: T): T",
        "export declare function g<U>(y: U): U"
      )
    ).toEqual(none)
  })

  it("calls an added overload or an appended optional parameter a widening", () => {
    expect(
      counts(
        "export declare function f(a: string): void",
        "export declare function f(a: string): void\nexport declare function f(a: number): void"
      ).widened
    ).toEqual(["p:f"])
    expect(
      counts(
        "export declare function f(a: string): void",
        "export declare function f(a: string, b?: number): void"
      ).widened
    ).toEqual(["p:f"])
  })

  it("finds a changed signature and a new deprecation", () => {
    expect(
      counts(
        "export declare function f(a: string): void",
        "export declare function f(a: number): void"
      ).changed
    ).toEqual(["p:f"])
    expect(
      counts(
        "export declare function f(): void",
        "/** @deprecated use g */\nexport declare function f(): void"
      ).deprecated
    ).toEqual(["p:f"])
  })

  it("reports a removed class once, not once per member", () => {
    expect(
      counts(
        "export declare class A { x(): void; y: number }\nexport declare function k(): void",
        "export declare function k(): void"
      ).removed
    ).toEqual(["p:A"])
  })

  it("follows a namespace that became an alias of `default`", () => {
    // zod 3.25: `export { z }` next to `export default z` walks as `lib:default`, `lib:z` its alias
    const ns = "declare namespace z { function object(a: string): void }"
    expect(
      counts(`${ns}\nexport { z }`, `${ns}\nexport { z }\nexport default z`)
    ).toEqual({ ...none, added: ["p:default"] })
  })

  it("follows a name that the old surface reached through an alias", () => {
    // @types/ws 8.18: `WebSocketServer` leaves the default namespace and stays a named export
    const a =
      "declare namespace ws { interface WebSocketServer { close(): void } }\nexport default ws\nexport import WebSocketServer = ws.WebSocketServer"
    const b =
      "export interface WebSocketServer { close(): void }\ndeclare namespace ws {}\nexport default ws"
    expect(counts(a, b).removed).toEqual([])
  })

  it("does not call a name removed when it may come from an unfollowed `export *`", () => {
    // @tanstack/react-query 5.102: named re-exports replaced by `export * from "@tanstack/query-core"`
    expect(
      counts(
        'export { QueryClient } from "query-core"\nexport declare function useQuery(): void',
        'export * from "query-core"\nexport declare function useQuery(): void'
      )
    ).toEqual({
      ...none,
      unproven: ["external-reexport p:QueryClient"],
    })
  })

  it("does not call a member removed when the new class extends a type it cannot load", () => {
    // msw 2.15: `class HttpResponse extends FetchResponse`, imported from @mswjs/interceptors
    expect(
      counts(
        "export declare class R extends Response { static redirect(url: string): Response }",
        'import { FetchResponse } from "interceptors"\nexport declare class R extends FetchResponse {}'
      ).unproven
    ).toContain("unresolved-base p:R#headers")
    expect(
      counts(
        "export declare class R extends Response {}\nexport type S = R",
        'import { FetchResponse } from "interceptors"\nexport declare class R extends FetchResponse {}\nexport type S = R'
      ).unproven
    ).toContain("unresolved-base p:S#headers")
  })

  it("does not call a name removed when the new surface stopped at the symbol cap", () => {
    const a = surface(
      "export declare function h(): void\nexport declare function k(): void"
    )
    const b = surface("export declare function k(): void")
    b.flags = ["symbol-cap"]
    expect(diffSurfaces(a, b).unproven.map((c) => c.path)).toEqual(["p:h"])
    expect(diffSurfaces(a, b).removed).toEqual([])
  })

  it("does not let a named re-export from another package hide removals", () => {
    expect(
      counts(
        'export declare const MAX: number\nexport { Data } from "interceptors"',
        'export { Data } from "interceptors"'
      ).removed
    ).toEqual(["p:MAX"])
  })

  it("keeps a removal it can prove", () => {
    // eslint-plugin-react-hooks 6.1: the named `configs` export became a property of `default`
    expect(
      counts(
        "export declare const configs: { recommended: string }",
        "declare const plugin: { configs: { recommended: string } }\nexport { plugin as default }"
      ).removed
    ).toEqual(["p:configs"])
  })

  it("calls a namespace that gains a signature a widening", () => {
    expect(
      counts(
        "declare namespace ws { interface Options { a: string } }\nexport default ws",
        "declare class ws { constructor(a: string) }\ndeclare namespace ws { interface Options { a: string } }\nexport default ws"
      )
    ).toEqual({
      ...none,
      widened: ["p:default"],
      added: ["p:default.prototype"],
    })
  })

  it("collapses one change seen through several paths", () => {
    const a =
      "declare namespace ns { function f(a: string): void }\nexport { ns }\nexport declare function f(a: string): void"
    const b =
      "declare namespace ns { function f(a: number): void }\nexport { ns }\nexport declare function f(a: number): void"
    const d = diffSurfaces(surface(a), surface(b))
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0]!.alsoAt).toHaveLength(1)
  })
})

describe("resolveRef", () => {
  // a common shape: everything lives in one module, re-exported flat and as the `v` namespace
  const external = `
export interface StringSchema { max(n: number): this; trim(): StringSchema }
export interface EmailSchema { max(n: number): this }
export declare function string(): StringSchema
export declare function email(): EmailSchema
`
  const index = `import * as v from "./external"\nexport * from "./external"\nexport { v, v as default }\n`
  const s = surface(
    index,
    { name: "schemakit", types: "index.d.ts" },
    { "external.d.ts": external }
  )
  const ref = (over: Partial<RawRef>): RawRef => ({
    installedId: "v",
    pkg: "schemakit",
    specifier: "schemakit",
    entry: ".",
    binding: { kind: "namespace" },
    chain: [],
    callSelf: false,
    site: { file: "a.ts", line: 1, col: 1, typeOnly: false, text: "" },
    ...over,
  })

  it("walks through return types", () => {
    const r = resolveRef(
      s,
      ref({
        chain: [
          { name: "email", call: true },
          { name: "max", call: true },
        ],
      })
    )
    expect(r.paths).toContain("schemakit:email")
    expect(r.paths.some((p) => p.endsWith("EmailSchema#max"))).toBe(true)
    expect(r.unresolvedTail).toEqual([])
  })

  it("reads `import { v }` and a default import as the namespace", () => {
    const named = resolveRef(
      s,
      ref({
        binding: { kind: "named", imported: "v" },
        chain: [
          { name: "string", call: true },
          { name: "trim", call: true },
        ],
      })
    )
    expect(named.paths.some((p) => p.endsWith("StringSchema#trim"))).toBe(true)
    const dflt = resolveRef(
      s,
      ref({
        binding: { kind: "default" },
        chain: [{ name: "string", call: true }],
      })
    )
    expect(dflt.paths.some((p) => p.endsWith("string"))).toBe(true)
  })

  it("continues a derived value from its construction", () => {
    const r = resolveRef(
      s,
      ref({
        binding: { kind: "derived" },
        chain: [{ name: "max", call: true }],
        origin: {
          binding: { kind: "named", imported: "string" },
          entry: ".",
          chain: [],
          callSelf: true,
        },
      })
    )
    expect(r.paths.length).toBeGreaterThan(0)
    expect(r.paths.every((p) => p.endsWith("#max"))).toBe(true)
  })

  it("flags a name the surface does not have", () => {
    expect(
      resolveRef(s, ref({ chain: [{ name: "nope", call: true }] })).missingHead
    ).toBe(true)
  })

  it("walks the members of an `export =` object", () => {
    const g = surface(
      "declare const globals: { browser: Record<string, boolean>; node: Record<string, boolean> }\nexport = globals",
      { name: "globals", types: "index.d.ts" }
    )
    expect(
      resolveRef(
        g,
        ref({
          pkg: "globals",
          binding: { kind: "default" },
          chain: [{ name: "browser", call: false }],
        })
      ).paths
    ).toEqual(["globals:browser"])
  })
})

describe("options", () => {
  it("records the properties an options parameter declares, union members included", () => {
    const s = surface(
      [
        "export interface ConfigOptions { path?: string; quiet?: boolean }",
        "export declare function config(options?: ConfigOptions): void",
        "type Hsts = { hsts?: boolean } | { strictTransportSecurity?: boolean }",
        "export default function helmet(options?: Readonly<{ contentSecurityPolicy?: boolean } & Hsts>): void",
        "export interface Client { get(key: string): string; quiet?: boolean }",
        "export declare function t(key: string, options?: { returnNull?: boolean }): string",
      ].join("\n")
    )
    expect(s.symbols["p:config"]?.options).toEqual(["path", "quiet"])
    expect(s.symbols["p:default"]?.options).toEqual([
      "contentSecurityPolicy",
      "hsts",
      "strictTransportSecurity",
    ])
    expect(s.symbols["p:t"]?.options).toEqual(["returnNull"])
    expect(s.symbols["p:Client#get"]?.options).toBeUndefined()
  })

  it("reads nothing from a value handed over rather than options", () => {
    const s = surface(
      [
        "export declare class Schema { parse(x: unknown): unknown; optional: boolean }",
        "export interface Api { get(): void; post(): void; base?: string }",
        "export declare function use(schema: Schema, api: Api, cb: (x: { a: 1 }) => void): void",
      ].join("\n")
    )
    expect(s.symbols["p:use"]?.options).toBeUndefined()
  })
})

describe("readTarball", () => {
  it("round-trips what the fixture packer writes, without the root folder", () => {
    const files = readTarball(
      packTarball({ "package.json": "{}", "lib/index.d.ts": "export {}" }),
      () => true
    )
    expect([...files.keys()]).toEqual(["package.json", "lib/index.d.ts"])
  })
})
