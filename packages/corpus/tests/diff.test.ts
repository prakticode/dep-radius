import { describe, expect, it } from "vitest"

import { expectedLines, importsPackage, parseDiff } from "../src/diff.ts"

const DIFF = `diff --git a/src/api.ts b/src/api.ts
index 1111111..2222222 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -3 +3 @@ import { z } from "zod"
-const id = z.string().uuid()
+const id = z.uuid()
@@ -10,2 +10,3 @@ export function parse(input: unknown) {
-  return schema.parse(input)
-  // done
+  const out = schema.safeParse(input)
+  if (!out.success) throw out.error
+  return out.data
@@ -20,0 +22,2 @@ export function more() {
+  const a = 1
+  const b = 2
diff --git a/src/old.js b/src/old.js
deleted file mode 100644
index 3333333..0000000
--- a/src/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-const express = require("express")
-module.exports = express()
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const x = 1
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
index 7777777..8888888 100644
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`

describe("parseDiff", () => {
  const files = parseDiff(DIFF)

  it("numbers removed lines in the old file and added lines in the new one", () => {
    expect(files[0]).toEqual({
      oldPath: "src/api.ts",
      newPath: "src/api.ts",
      removed: [
        { line: 3, text: "const id = z.string().uuid()" },
        { line: 10, text: "  return schema.parse(input)" },
        { line: 11, text: "  // done" },
      ],
      added: [
        { line: 3, text: "const id = z.uuid()" },
        { line: 10, text: "  const out = schema.safeParse(input)" },
        { line: 11, text: "  if (!out.success) throw out.error" },
        { line: 12, text: "  return out.data" },
        { line: 22, text: "  const a = 1" },
        { line: 23, text: "  const b = 2" },
      ],
    })
  })

  it("leaves the missing side of a deleted or created file undefined", () => {
    expect(files[1]).toMatchObject({ oldPath: "src/old.js" })
    expect(files[1]!.newPath).toBeUndefined()
    expect(files[2]).toMatchObject({ newPath: "src/new.ts" })
    expect(files[2]!.oldPath).toBeUndefined()
  })

  it("keeps a binary file without lines", () => {
    expect(files[3]).toEqual({ removed: [], added: [] })
  })

  it("unquotes a path git escaped, and skips the no-newline marker", () => {
    expect(files[4]).toEqual({
      oldPath: "src/café.ts",
      newPath: "src/café.ts",
      removed: [{ line: 1, text: "old" }],
      added: [{ line: 1, text: "new" }],
    })
  })
})

describe("importsPackage", () => {
  it("sees imports, re-exports, requires and dynamic imports, with subpaths", () => {
    expect(importsPackage(`import { z } from "zod"`, "zod")).toBe(true)
    expect(importsPackage(`export * from 'zod/v4'`, "zod")).toBe(true)
    expect(importsPackage(`const e = require( "express" )`, "express")).toBe(
      true
    )
    expect(importsPackage(`await import("@scope/pkg/sub")`, "@scope/pkg")).toBe(
      true
    )
    expect(importsPackage(`import "zod"`, "zod")).toBe(true)
  })

  it("does not take a package whose name only starts the same", () => {
    expect(importsPackage(`import x from "zod-to-json"`, "zod")).toBe(false)
    expect(importsPackage(`// zod is great`, "zod")).toBe(false)
  })
})

describe("expectedLines", () => {
  const sources: Record<string, string> = {
    "src/api.ts": `import { z } from "zod"\n`,
    "src/old.js": `const express = require("express")\n`,
  }

  it("keeps meaningful removed lines of files importing an upgraded package", () => {
    const out = expectedLines(parseDiff(DIFF), ["zod"], (p) => sources[p])
    expect(out.empty).toBeUndefined()
    expect(out.expected).toEqual([
      {
        file: "src/api.ts",
        line: 3,
        text: "const id = z.string().uuid()",
        imports: ["zod"],
      },
      {
        file: "src/api.ts",
        line: 10,
        text: "  return schema.parse(input)",
        imports: ["zod"],
      },
    ])
    expect(out.added.map((a) => a.line)).toEqual([3, 10, 11, 12, 22, 23])
  })

  it("lists every upgraded package a file imports", () => {
    const out = expectedLines(parseDiff(DIFF), ["express", "zod"], (p) =>
      p === "src/old.js" ? `${sources[p]}import "zod"` : sources[p]
    )
    expect(out.expected.find((e) => e.file === "src/old.js")?.imports).toEqual([
      "express",
      "zod",
    ])
  })

  it("says why nothing was kept", () => {
    expect(expectedLines([], ["zod"], () => "").empty).toBe(
      "fix changes no source file"
    )
    const onlyAdds = parseDiff(
      `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +2 @@\n+x()\n`
    )
    expect(expectedLines(onlyAdds, ["zod"], () => "").empty).toBe(
      "fix only adds lines"
    )
    expect(
      expectedLines(parseDiff(DIFF), ["react"], (p) => sources[p]).empty
    ).toBe("no changed file imports an upgraded package")
  })
})
