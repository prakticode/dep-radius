import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // the benchmark's fixture projects carry their own test files, which are data
    exclude: ["tests/benchmark/cases/**", "**/node_modules/**"],
    testTimeout: 30_000,
  },
})
