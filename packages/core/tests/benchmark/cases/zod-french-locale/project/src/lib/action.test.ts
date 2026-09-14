import { expect, it } from "vitest"

import { z } from "./zod"

it("reports a French message for an empty name", () => {
  const result = z.object({ name: z.string().min(1) }).safeParse({ name: "" })
  expect(result.error?.issues[0]?.message).toBe(
    "Trop petit : chaîne doit avoir >=1 caractères"
  )
})
