import { createPrivateKey } from "node:crypto"
import { readFileSync } from "node:fs"
import { SignJWT, jwtVerify } from "jose"

const privateKey = createPrivateKey(readFileSync(process.env.JWT_PRIVATE_KEY_PATH))

export function issueToken(userId) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "RS256" })
    .setExpirationTime("1h")
    .sign(privateKey)
}

export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, privateKey)
  return payload.sub
}
