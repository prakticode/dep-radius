import jwt from "jsonwebtoken"

export function readSession(token: string) {
  return jwt.verify(token, process.env.JWT_SECRET ?? "")
}
