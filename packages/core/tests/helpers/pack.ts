import { gzipSync } from "node:zlib"
import { createHash } from "node:crypto"

// A minimal ustar writer, enough to publish fixture packages to the fake registry.
export function packTarball(
  files: Record<string, string>,
  root = "package"
): Buffer {
  const blocks: Buffer[] = []
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8")
    const header = Buffer.alloc(512)
    const name = `${root}/${path}`
    if (name.length > 100) throw new Error(`fixture path too long: ${name}`)
    header.write(name, 0, "utf8")
    header.write("0000644\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124)
    header.write("00000000000\0", 136)
    header.write("        ", 148)
    header.write("0", 156)
    header.write("ustar\0", 257)
    header.write("00", 263)
    let sum = 0
    for (const b of header) sum += b
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`
}
