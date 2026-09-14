import { config } from "@repo/eslint-config"

export default [
  // the benchmark's fixture projects are data: code as real projects write it
  { ignores: ["tests/benchmark/cases/**"] },
  ...config({
    tsconfigRootDir: import.meta.dirname,
    envAllowedIn: ["src/context.ts", "src/debug.ts", "scripts/**"],
  }),
]
