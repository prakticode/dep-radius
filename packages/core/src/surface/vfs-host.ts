import { dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"

import ts from "typescript"

export const PKG_ROOT = "/pkg"

const libDir = dirname(ts.getDefaultLibFilePath({}))
const libSources = new Map<string, ts.SourceFile>()

// A compiler host that sees the tarball's declarations under /pkg and the TypeScript lib files the
// tool itself bundles, nothing else: the user's node_modules can never change a surface.
export function createVfsHost(files: Map<string, Buffer>): ts.CompilerHost {
  const texts = new Map<string, string>()
  const dirs = new Set<string>([PKG_ROOT])
  for (const [rel, buf] of files) {
    const abs = `${PKG_ROOT}/${rel}`
    texts.set(abs, buf.toString("utf8"))
    let d = dirname(abs)
    while (d.startsWith(PKG_ROOT) && !dirs.has(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  const isLib = (f: string) => f.startsWith(libDir)
  return {
    getSourceFile(fileName, languageVersion) {
      if (isLib(fileName)) {
        let sf = libSources.get(fileName)
        if (!sf && existsSync(fileName)) {
          sf = ts.createSourceFile(
            fileName,
            readFileSync(fileName, "utf8"),
            languageVersion,
            false
          )
          libSources.set(fileName, sf)
        }
        return sf
      }
      const text = texts.get(fileName)
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, false)
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    getDefaultLibLocation: () => libDir,
    writeFile: () => {},
    getCurrentDirectory: () => PKG_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => texts.has(f) || (isLib(f) && existsSync(f)),
    readFile: (f) =>
      texts.get(f) ??
      (isLib(f) && existsSync(f) ? readFileSync(f, "utf8") : undefined),
    directoryExists: (d) =>
      dirs.has(d.replace(/\/$/, "")) || isLib(d) || d === libDir,
    getDirectories: () => [],
    realpath: (p) => p,
  }
}

export function libPath(name: string): string {
  return join(libDir, name)
}
