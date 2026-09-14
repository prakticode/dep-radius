import { describe, expect, it } from "vitest"

import { packageLines } from "../src/usage-lines.ts"

const lines = (s: Set<number>) => [...s].sort((a, b) => a - b)

describe("packageLines", () => {
  it("finds option keys at any depth in an object passed to a package's call", () => {
    const src = [
      `import { defineConfig } from "tsdown"`, // 1
      `export default defineConfig({`, // 2
      `  entry: ["src/index.ts"],`, // 3
      `  dts: {`, // 4
      `    sourcemap: true,`, // 5
      `  },`, // 6
      `  plugins: [{ name: "x" }],`, // 7
      `})`, // 8
      `const other = { dts: true }`, // 9
    ].join("\n")
    const out = packageLines("tsdown.config.ts", src, "tsdown")
    expect(lines(out.options)).toEqual([3, 4, 5, 7])
    expect(lines(out.refs)).toEqual([2])
  })

  it("follows chains and constructors", () => {
    const src = [
      `const { Queue } = require("bullmq")`,
      `const q = new Queue("jobs", {`,
      `  connection,`,
      `})`,
      `import * as z from "zod"`,
      `z.object({ id: z.string() }).extend({`,
      `  name: z.string(),`,
      `})`,
    ].join("\n")
    expect(lines(packageLines("a.js", src, "bullmq").options)).toEqual([3])
    expect(lines(packageLines("a.js", src, "zod").options)).toEqual([6, 7])
  })

  it("finds imported types, and the keys of objects they annotate", () => {
    const src = [
      `import type { Options, Plugin } from "some-lib/types"`, // 1
      `const opts: Options = {`, // 2
      `  retries: 3,`, // 3
      `}`, // 4
      `export const p = { name: "p" } satisfies Plugin`, // 5
      `function f(): Promise<Options | undefined> {`, // 6
      `  return undefined`, // 7
      `}`, // 8
      `type Local = { retries: number }`, // 9
    ].join("\n")
    const out = packageLines("a.ts", src, "some-lib")
    expect(lines(out.types)).toEqual([2, 5, 6])
    expect(lines(out.options)).toEqual([3, 5])
  })

  it("counts JSX attributes of a package's component as options", () => {
    const src = [
      `import { Button } from "ui-kit"`,
      `export const A = () => (`,
      `  <Button`,
      `    variant="primary"`,
      `  />`,
      `)`,
    ].join("\n")
    expect(lines(packageLines("a.tsx", src, "ui-kit").options)).toEqual([4])
  })

  it("keeps the line numbers of a Vue file's script", () => {
    const src = [
      `<template><div /></template>`,
      `<script setup lang="ts">`,
      `import { ref } from "vue"`,
      `const a = ref({ deep: true })`,
      `</script>`,
    ].join("\n")
    expect(lines(packageLines("A.vue", src, "vue").options)).toEqual([4])
  })

  it("does not take a package whose name only starts the same, nor a property of that name", () => {
    const src = [
      `import { defineConfig } from "vite-plus"`,
      `import x from "vite"`,
      `obj.defineConfig({ a: 1 })`,
    ].join("\n")
    const out = packageLines("a.ts", src, "vite")
    expect(out.options.size).toBe(0)
  })
})
