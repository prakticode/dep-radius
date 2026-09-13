import { gunzipSync } from "node:zlib"

// Reads a gzipped npm tarball in memory. Nothing touches the disk, so a hostile path cannot escape.
// Ustar prefixes, pax `path` records and GNU long names are all read; strips the first path segment,
// which npm writes as `package/` but some publishers name differently.
export function readTarball(
  tgz: Uint8Array,
  keep: (path: string) => boolean
): Map<string, Buffer> {
  const buf = gunzipSync(tgz)
  const out = new Map<string, Buffer>()
  let offset = 0
  let paxPath: string | undefined
  let longName: string | undefined
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = cstr(header.subarray(0, 100))
    const size = parseOctal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156] ?? 48)
    const magic = cstr(header.subarray(257, 263))
    const prefix = magic.startsWith("ustar")
      ? cstr(header.subarray(345, 500))
      : ""
    const dataStart = offset + 512
    const data = buf.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === "x") {
      paxPath = parsePax(data).path ?? paxPath
      continue
    }
    if (type === "g") continue
    if (type === "L") {
      longName = cstr(data)
      continue
    }
    const full = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)
    paxPath = undefined
    longName = undefined
    if (type !== "0" && type !== "\0" && type !== "7") continue
    const rel = full.replace(/^\/+/, "").split("/").slice(1).join("/")
    if (!rel || rel.split("/").includes("..")) continue
    if (keep(rel)) out.set(rel, Buffer.from(data))
  }
  return out
}

function cstr(b: Uint8Array): string {
  const end = b.indexOf(0)
  return Buffer.from(end < 0 ? b : b.subarray(0, end)).toString("utf8")
}

function parseOctal(b: Uint8Array): number {
  // base-256 for sizes above 8 GiB never occurs in npm tarballs
  const s = cstr(b).trim()
  return s ? parseInt(s, 8) : 0
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  const text = Buffer.from(data).toString("utf8")
  let i = 0
  while (i < text.length) {
    const space = text.indexOf(" ", i)
    if (space < 0) break
    const len = parseInt(text.slice(i, space), 10)
    if (!len) break
    const record = text.slice(space + 1, i + len - 1)
    const eq = record.indexOf("=")
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += len
  }
  return out
}
