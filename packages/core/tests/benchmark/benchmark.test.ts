import { describe, expect, it } from "vitest"

import { assertWellFormed, loadCases, runCase } from "./harness.ts"

describe("behaviour change benchmark", () => {
  for (const c of loadCases()) {
    it(`${c.id} is ${c.status}`, async () => {
      assertWellFormed(c)
      const result = await runCase(c)
      expect(result.status).toBe(c.status)
    })
  }
})
