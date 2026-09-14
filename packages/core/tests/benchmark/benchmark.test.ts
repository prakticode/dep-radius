import { describe, expect, it } from "vitest"

import { assertWellFormed, loadCases, runCase } from "./harness.ts"

describe("behaviour change benchmark", () => {
  for (const c of loadCases()) {
    it(`${c.id} is ${c.status}`, async () => {
      assertWellFormed(c)
      const result = await runCase(c)
      expect(result.status).toBe(c.status)
      // every case is a documented change to code the project uses: quiet on it is a wrong quiet
      expect(result.verdict).not.toBe("quiet")
    })
  }
})
