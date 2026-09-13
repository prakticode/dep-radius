import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"

export interface ProjectLayout {
  files: Record<string, string>
  // link path -> target path, both relative to the project root
  symlinks?: Record<string, string>
}

export function createProject(layout: ProjectLayout): {
  root: string
  cleanup: () => void
} {
  const root = mkdtempSync(join(tmpdir(), "radius-"))
  // a .git folder bounds the node_modules walk, as a real repository would
  mkdirSync(join(root, ".git"))
  for (const [rel, content] of Object.entries(layout.files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  for (const [link, target] of Object.entries(layout.symlinks ?? {})) {
    const abs = join(root, link)
    mkdirSync(dirname(abs), { recursive: true })
    symlinkSync(join(root, target), abs, "dir")
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export function pkgJson(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields, null, 2)}\n`
}
