import { z } from "../lib/zod"

export const feedbackSchema = z.object({
  email: z.email(),
  message: z.string().min(10).max(2000),
})
