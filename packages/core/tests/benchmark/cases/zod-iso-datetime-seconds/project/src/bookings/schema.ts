import { z } from "zod"

export const bookingSchema = z.object({
  roomId: z.string(),
  startsAt: z.iso.datetime(),
})
