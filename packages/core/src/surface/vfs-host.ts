import { dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"

import ts from "typescript"

export const PKG_ROOT = "/pkg"
// above /pkg, so the package's own imports find them the way Node would
export const DEPS_ROOT = "/node_modules"

const libDir = dirname(ts.getDefaultLibFilePath({}))
const libSources = new Map<string, ts.SourceFile>()

// A compiler host that sees the tarball's declarations under /pkg, the declarations of the
// dependencies it imports under /node_modules, and the TypeScript lib files the tool itself bundles,
// nothing else: the user's node_modules can never change a surface.
export function createVfsHost(
  files: Map<string, Buffer>,
  dependencies: ReadonlyMap<string, Map<string, Buffer>> = new Map()
): ts.CompilerHost {
  const texts = new Map<string, string>()
  const dirs = new Set<string>(["/"])
  const mount = (root: string, tree: Map<string, Buffer>) => {
    for (const [rel, buf] of tree) {
      const abs = `${root}/${rel}`
      texts.set(abs, buf.toString("utf8"))
      for (let d = dirname(abs); !dirs.has(d); d = dirname(d)) dirs.add(d)
    }
  }
  mount(PKG_ROOT, files)
  dirs.add(PKG_ROOT)
  for (const [name, tree] of dependencies) mount(`${DEPS_ROOT}/${name}`, tree)
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
