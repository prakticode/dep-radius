import { validate } from "class-validator"
import type { RequestHandler } from "express"

export function validateBody(Dto: new () => object): RequestHandler {
  return async (req, res, next) => {
    const body = Object.assign(new Dto(), req.body)
    const errors = await validate(body, { whitelist: true })
    if (errors.length > 0) {
      res.status(400).json({ errors: errors.map((e) => e.constraints) })
      return
    }
    req.body = body
    next()
  }
}
