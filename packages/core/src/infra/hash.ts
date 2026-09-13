import { createHash } from "node:crypto"

export function sha1(data: string | Uint8Array): string {
  return createHash("sha1").update(data).digest("hex")
}

// npm integrity strings are "sha512-<base64>"; the cache is keyed by the hex digest.
export function integrityHex(integrity: string): string | undefined {
  const m = /^sha512-(.+)$/.exec(
    integrity.split(/\s+/).find((s) => s.startsWith("sha512-")) ?? ""
  )
  return m?.[1] ? Buffer.from(m[1], "base64").toString("hex") : undefined
}

export function verifyIntegrity(bytes: Uint8Array, integrity: string): boolean {
  const hex = integrityHex(integrity)
  if (hex) return createHash("sha512").update(bytes).digest("hex") === hex
  const sha1m = /^sha1-(.+)$/.exec(integrity)
  if (sha1m?.[1])
    return createHash("sha1").update(bytes).digest("base64") === sha1m[1]
  return false
}
