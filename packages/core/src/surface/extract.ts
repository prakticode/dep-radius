import ts from "typescript"

import type { Ctx } from "../options.ts"
import { resolveEntries } from "./entries.ts"
import { integrityHex } from "../infra/hash.ts"
import { createVfsHost, PKG_ROOT } from "./vfs-host.ts"
import { getTarballFiles } from "../registry/tarball.ts"
import type { Packument } from "../registry/packument.ts"
import type { RegistryConfig } from "../registry/npmrc.ts"
import { ALGO, signatureText, typeText } from "./signature.ts"
import { formatPath, parsePath, type Seg } from "../symbol-path.ts"
import type { CanonPath, Surface, SurfaceSymbol, SymbolKind } from "../model.ts"

const SYMBOL_CAP = 25_000
const NAMESPACE_DEPTH = 2

export type ExtractResult =
  | { ok: true; surface: Surface }
  | {
      ok: false
      reason: "no-types" | "offline-uncached" | "failed"
      detail?: string
    }

export async function extractSurface(
  ctx: Ctx,
  cfg: RegistryConfig,
  p: Packument,
  version: string,
  wantedSubpaths: string[] = []
): Promise<ExtractResult> {
  const pv = p.versions[version]
  if (!pv)
    return {
      ok: false,
      reason: "failed",
      detail: `version ${version} not in registry`,
    }
  const integrity = pv.dist.integrity ?? pv.dist.shasum ?? pv.dist.tarball
  const wantedKey = wantedSubpaths
    .filter((w) => w.includes("/") && w !== ".")
    .sort()
    .join(",")
  const key = `surfaces/${integrityHex(integrity) ?? Buffer.from(integrity).toString("hex").slice(0, 64)}.a${ALGO}.ts${ts.version}${wantedKey ? `.${Buffer.from(wantedKey).toString("base64url").slice(0, 40)}` : ""}.json`
  const cached = await ctx.cache.getJson<ExtractResult>(key)
  if (cached) return cached.value

  const tb = await getTarballFiles(ctx, cfg, pv)
  if (!tb.ok)
    return {
      ok: false,
      reason: tb.reason === "offline-uncached" ? "offline-uncached" : "failed",
      detail: tb.reason,
    }
  const result = await ctx.heavy(async () =>
    build(p.name, version, integrity, tb.files, wantedSubpaths)
  )
  await ctx.cache.setJson(key, result, ctx.now)
  return result
}

export function build(
  pkg: string,
  version: string,
  integrity: string,
  files: Map<string, Buffer>,
  wantedSubpaths: string[] = []
): ExtractResult {
  const pjBuf = files.get("package.json")
  let pj: Record<string, unknown> = {}
  try {
    pj = pjBuf
      ? (JSON.parse(pjBuf.toString("utf8")) as Record<string, unknown>)
      : {}
  } catch {
    return { ok: false, reason: "failed", detail: "unreadable package.json" }
  }
  const fileList = [...files.keys()]
  const { entries, wildcardTruncated } = resolveEntries(
    pj,
    fileList,
    wantedSubpaths
  )
  if (entries.length === 0) return { ok: false, reason: "no-types" }

  const options: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    strict: true,
    allowJs: false,
    noLib: false,
  }
  const host = createVfsHost(files)
  const program = ts.createProgram({
    rootNames: entries.map((e) => `${PKG_ROOT}/${e.typesFile}`),
    options,
    host,
  })
  const checker = program.getTypeChecker()

  const symbols: Record<CanonPath, SurfaceSymbol> = {}
  const surfaceEntries: Surface["entries"] = {}
  const firstPath = new Map<ts.Symbol, CanonPath>()
  const pendingReturns: {
    path: CanonPath
    field: "returns" | "instanceOf"
    target: ts.Symbol
    owner?: CanonPath
  }[] = []
  const flags = new Set<Surface["flags"][number]>()
  if (wildcardTruncated) flags.add("wildcard-truncated")
  let count = 0

  const inPackage = (s: ts.Symbol | undefined) =>
    !!s?.declarations?.some((d) =>
      d.getSourceFile().fileName.startsWith(`${PKG_ROOT}/`)
    )
  const deprecatedOf = (s: ts.Symbol) =>
    !!s.declarations?.some((d) => ts.getJSDocDeprecatedTag(d))
  // `class HttpResponse extends FetchResponse`, FetchResponse imported from a dependency: `any` here
  const extendsUnresolved = (s: ts.Symbol) =>
    !!s.declarations?.some(
      (d) =>
        (ts.isClassLike(d) || ts.isInterfaceDeclaration(d)) &&
        !!d.heritageClauses?.some(
          (h) =>
            h.token === ts.SyntaxKind.ExtendsKeyword &&
            h.types.some(
              (t) => !!(checker.getTypeAtLocation(t).flags & ts.TypeFlags.Any)
            )
        )
    )
  const emit = (sym: SurfaceSymbol) => {
    if (count >= SYMBOL_CAP) {
      flags.add("symbol-cap")
      return false
    }
    if (symbols[sym.path]) return false
    symbols[sym.path] = sym
    count++
    return true
  }
  const resolveAlias = (s: ts.Symbol): ts.Symbol => {
    if (!(s.flags & ts.SymbolFlags.Alias)) return s
    try {
      return checker.getAliasedSymbol(s)
    } catch {
      return s
    }
  }
  const typeSymbolOf = (t: ts.Type): ts.Symbol | undefined => {
    const s = t.aliasSymbol ?? t.getSymbol()
    if (!s || !inPackage(s)) return undefined
    if (
      s.flags &
      (ts.SymbolFlags.Class |
        ts.SymbolFlags.Interface |
        ts.SymbolFlags.TypeAlias)
    )
      return s
    return undefined
  }
  const isThisType = (t: ts.Type) =>
    !!(t.flags & ts.TypeFlags.TypeParameter) &&
    (t as ts.TypeParameter & { isThisType?: boolean }).isThisType === true

  const callSigs = (t: ts.Type, path: CanonPath): string[] => {
    const sigs = t.getCallSignatures()
    const first = sigs[0]
    if (first) {
      const rs = typeSymbolOf(checker.getReturnTypeOfSignature(first))
      if (rs) pendingReturns.push({ path, field: "returns", target: rs })
    }
    return sigs.map((s) => signatureText(checker, s)).sort()
  }

  const walkMembers = (
    ownerPath: CanonPath,
    type: ts.Type,
    sep: "#" | ".",
    pkgName: string,
    entry: string,
    segs: Seg[]
  ) => {
    for (const prop of checker.getPropertiesOfType(type)) {
      const name = prop.getName()
      if (
        name === "prototype" ||
        name.startsWith("__@") ||
        name.startsWith("#")
      )
        continue
      const decl = prop.valueDeclaration ?? prop.declarations?.[0]
      if (
        decl &&
        ts.getCombinedModifierFlags(decl) &
          (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)
      )
        continue
      const path = formatPath(pkgName, entry, [...segs, { name, sep }])
      let ptype: ts.Type
      try {
        ptype = decl
          ? checker.getTypeOfSymbolAtLocation(prop, decl)
          : checker.getTypeOfSymbol(prop)
      } catch {
        continue
      }
      const record: SurfaceSymbol = {
        path,
        kind: sep === "#" ? "member" : "static-member",
        sig: [],
        deprecated: deprecatedOf(prop),
      }
      if (!emit(record)) continue
      const sigs = ptype.getCallSignatures()
      if (sigs.length > 0) {
        record.sig = sigs.map((s) => signatureText(checker, s)).sort()
        const r = checker.getReturnTypeOfSignature(sigs[0]!)
        const rs = isThisType(r) ? undefined : typeSymbolOf(r)
        if (rs) pendingReturns.push({ path, field: "returns", target: rs })
        // `refine(): Ch extends ... ? this & X : this` has no symbol, and is still the owner
        else if (
          isThisType(r) ||
          mentionsOwner(checker.typeToString(r), ownerPath)
        )
          record.returns = ownerPath
      } else {
        record.sig = [typeText(checker, ptype)]
        const ts2 = typeSymbolOf(ptype)
        if (ts2) pendingReturns.push({ path, field: "instanceOf", target: ts2 })
      }
    }
  }

  const walk = (
    pkgName: string,
    entry: string,
    segs: Seg[],
    raw: ts.Symbol,
    nsDepth: number
  ) => {
    if (count >= SYMBOL_CAP) {
      flags.add("symbol-cap")
      return
    }
    const sym = resolveAlias(raw)
    const path = formatPath(pkgName, entry, segs)
    const seen = firstPath.get(sym)
    const f = sym.flags
    const isModule =
      !!(f & ts.SymbolFlags.ValueModule) &&
      !!sym.declarations?.some(
        (d) => ts.isSourceFile(d) || ts.isModuleDeclaration(d)
      )
    const isNamespaceOnly =
      isModule ||
      (!!(f & ts.SymbolFlags.NamespaceModule) &&
        !(
          f &
          (ts.SymbolFlags.Function |
            ts.SymbolFlags.Class |
            ts.SymbolFlags.Variable |
            ts.SymbolFlags.Interface |
            ts.SymbolFlags.TypeAlias |
            ts.SymbolFlags.Enum)
        ))
    if (seen && seen !== path) {
      emit({
        path,
        kind: isNamespaceOnly ? "namespace" : kindOf(f),
        sig: [],
        deprecated: false,
        aliasOf: seen,
      })
      return
    }
    firstPath.set(sym, path)

    if (isNamespaceOnly) {
      emit({ path, kind: "namespace", sig: [], deprecated: false })
      if (nsDepth >= NAMESPACE_DEPTH) return
      let exports: ts.Symbol[] = []
      try {
        exports = checker.getExportsOfModule(sym)
      } catch {
        return
      }
      for (const e of [...exports].sort((a, b) =>
        a.getName().localeCompare(b.getName())
      )) {
        walk(
          pkgName,
          entry,
          [...segs, { name: e.getName(), sep: "." }],
          e,
          nsDepth + 1
        )
      }
      return
    }

    const record: SurfaceSymbol = {
      path,
      kind: kindOf(f),
      sig: [],
      deprecated: deprecatedOf(sym),
    }
    if (
      f & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) &&
      extendsUnresolved(sym)
    )
      record.unresolvedBase = true
    if (!emit(record)) return
    try {
      if (f & ts.SymbolFlags.Class) {
        const staticType = checker.getTypeOfSymbol(sym)
        record.sig = staticType
          .getConstructSignatures()
          .map((s) => signatureText(checker, s))
          .sort()
        record.instanceOf = path
        walkMembers(
          path,
          checker.getDeclaredTypeOfSymbol(sym),
          "#",
          pkgName,
          entry,
          segs
        )
        walkMembers(path, staticType, ".", pkgName, entry, segs)
      } else if (f & ts.SymbolFlags.Interface) {
        const t = checker.getDeclaredTypeOfSymbol(sym)
        record.sig = t
          .getCallSignatures()
          .map((s) => signatureText(checker, s))
          .sort()
        walkMembers(path, t, "#", pkgName, entry, segs)
      } else if (f & ts.SymbolFlags.TypeAlias) {
        const t = checker.getDeclaredTypeOfSymbol(sym)
        const tps =
          (
            sym.declarations?.[0] as ts.TypeAliasDeclaration | undefined
          )?.typeParameters?.map((tp) => tp.name.text) ?? []
        record.sig = [typeText(checker, t, tps)]
        // `type StrictResponse<T> = HttpResponse<T>`: the members are the class's, base and all
        const target = t.getSymbol()
        if (target && target !== sym && extendsUnresolved(target))
          record.unresolvedBase = true
        if (t.flags & ts.TypeFlags.Object && !(t.flags & ts.TypeFlags.Union))
          walkMembers(path, t, "#", pkgName, entry, segs)
      } else if (f & ts.SymbolFlags.Enum) {
        const t = checker.getTypeOfSymbol(sym)
        for (const m of checker.getPropertiesOfType(t)) {
          emit({
            path: formatPath(pkgName, entry, [
              ...segs,
              { name: m.getName(), sep: "." },
            ]),
            kind: "enum-member",
            sig: [typeText(checker, checker.getTypeOfSymbol(m))],
            deprecated: deprecatedOf(m),
          })
        }
      } else if (
        f &
        (ts.SymbolFlags.Function |
          ts.SymbolFlags.Variable |
          ts.SymbolFlags.Property)
      ) {
        const decl = sym.valueDeclaration ?? sym.declarations?.[0]
        const t = decl
          ? checker.getTypeOfSymbolAtLocation(sym, decl)
          : checker.getTypeOfSymbol(sym)
        const sigs = callSigs(t, path)
        record.sig = sigs.length > 0 ? sigs : [typeText(checker, t)]
        if (sigs.length === 0) {
          const ts2 = typeSymbolOf(t)
          if (ts2)
            pendingReturns.push({ path, field: "instanceOf", target: ts2 })
          else if (
            f & ts.SymbolFlags.Variable &&
            t.flags & ts.TypeFlags.Object &&
            nsDepth < NAMESPACE_DEPTH
          ) {
            walkMembers(path, t, ".", pkgName, entry, segs)
          }
        }
        // function merged with a namespace: createApp(), createApp.json()
        if (f & ts.SymbolFlags.NamespaceModule && nsDepth < NAMESPACE_DEPTH) {
          for (const e of checker.getExportsOfModule(sym))
            walk(
              pkgName,
              entry,
              [...segs, { name: e.getName(), sep: "." }],
              e,
              nsDepth + 1
            )
        }
      }
      // a class, interface or type merged with a namespace: Dialog.Root and Dialog.Root.Props
      if (
        f &
          (ts.SymbolFlags.Class |
            ts.SymbolFlags.Interface |
            ts.SymbolFlags.TypeAlias |
            ts.SymbolFlags.Enum) &&
        f & ts.SymbolFlags.NamespaceModule &&
        nsDepth < NAMESPACE_DEPTH
      ) {
        for (const e of checker.getExportsOfModule(sym))
          walk(
            pkgName,
            entry,
            [...segs, { name: e.getName(), sep: "." }],
            e,
            nsDepth + 1
          )
      }
    } catch (error) {
      record.sig = [`#error:${String(error).slice(0, 40)}`]
    }
  }

  for (const e of entries) {
    const sf = program.getSourceFile(`${PKG_ROOT}/${e.typesFile}`)
    if (!sf) continue
    const moduleSym = checker.getSymbolAtLocation(sf)
    if (!moduleSym) continue
    const exportEquals = !!moduleSym.exports?.has(
      ts.InternalSymbolName.ExportEquals
    )
    const externalReexports = unresolvedReexports(sf, pkg, options, host)
    surfaceEntries[e.subpath] = {
      typesFile: e.typesFile,
      exportEquals,
      ...(externalReexports.length > 0 ? { externalReexports } : {}),
    }
    if (exportEquals) {
      const target = resolveAlias(
        moduleSym.exports!.get(ts.InternalSymbolName.ExportEquals)!
      )
      const decl = target.valueDeclaration ?? target.declarations?.[0]
      const path = formatPath(pkg, e.subpath, [])
      if (
        decl &&
        target.flags &
          (ts.SymbolFlags.Function |
            ts.SymbolFlags.Variable |
            ts.SymbolFlags.Class)
      ) {
        const t = checker.getTypeOfSymbolAtLocation(target, decl)
        const construct = t.getConstructSignatures()
        const callable =
          t.getCallSignatures().length > 0 || construct.length > 0
        const record: SurfaceSymbol = {
          path,
          kind:
            target.flags & ts.SymbolFlags.Class
              ? "class"
              : callable
                ? "function"
                : "variable",
          sig: [],
          deprecated: deprecatedOf(target),
        }
        if (emit(record)) {
          record.sig = callable
            ? [
                ...callSigs(t, path),
                ...construct.map((s) => `new ${signatureText(checker, s)}`),
              ].sort()
            : [typeText(checker, t)]
          if (construct[0]) {
            const rs = typeSymbolOf(
              checker.getReturnTypeOfSignature(construct[0])
            )
            if (rs)
              pendingReturns.push({ path, field: "instanceOf", target: rs })
          }
          // `export = globals` where globals is an object: its properties are the module's names
          if (!callable && t.flags & ts.TypeFlags.Object)
            walkMembers(path, t, ".", pkg, e.subpath, [])
        }
      }
    }
    let exports: ts.Symbol[] = []
    try {
      exports = checker.getExportsOfModule(moduleSym)
    } catch {
      continue
    }
    for (const ex of [...exports].sort((a, b) =>
      a.getName().localeCompare(b.getName())
    )) {
      if (ex.escapedName === ts.InternalSymbolName.ExportEquals) continue
      walk(pkg, e.subpath, [{ name: ex.getName(), sep: "." }], ex, 0)
    }
  }

  for (const r of pendingReturns) {
    const target = firstPath.get(r.target)
    const rec = symbols[r.path]
    if (target && rec) rec[r.field] = target
  }
  if (hasUnresolvedImports(program, options, host, pkg))
    flags.add("external-types-unresolved")

  return {
    ok: true,
    surface: {
      pkg,
      version,
      integrity,
      ts: ts.version,
      algo: ALGO,
      typesFrom: pkg.startsWith("@types/") ? "@types" : "package",
      entries: surfaceEntries,
      symbols,
      flags: [...flags].sort(),
    },
  }
}

// On an instantiated owner `this` already reads as the owner's name: `C extends ... ? StringSchema & X : StringSchema`
function mentionsOwner(text: string, ownerPath: CanonPath): boolean {
  const owner = parsePath(ownerPath).segs.at(-1)?.name
  if (/(?<![\w$.])this(?![\w$])/.test(text)) return true
  return (
    !!owner &&
    new RegExp(`(?<![\\w$.])${owner.replace(/[$]/g, "\\$")}(?![\\w$])`).test(
      text
    )
  )
}

function kindOf(f: ts.SymbolFlags): SymbolKind {
  if (f & ts.SymbolFlags.Class) return "class"
  if (f & ts.SymbolFlags.Interface) return "interface"
  if (f & ts.SymbolFlags.TypeAlias) return "type"
  if (f & ts.SymbolFlags.Enum) return "enum"
  if (f & ts.SymbolFlags.Function) return "function"
  if (f & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule))
    return "namespace"
  return "variable"
}

function unresolvedReexports(
  sf: ts.SourceFile,
  pkg: string,
  options: ts.CompilerOptions,
  host: ts.CompilerHost
): string[] {
  const out: string[] = []
  for (const stmt of sf.statements) {
    // `export { a } from "x"` still names `a`; only `export * from "x"` hides what it brings
    if (
      !ts.isExportDeclaration(stmt) ||
      stmt.exportClause ||
      !stmt.moduleSpecifier ||
      !ts.isStringLiteral(stmt.moduleSpecifier)
    )
      continue
    const name = stmt.moduleSpecifier.text
    if (name.startsWith(".") || name === pkg || name.startsWith(`${pkg}/`))
      continue
    if (
      !ts.resolveModuleName(name, sf.fileName, options, host).resolvedModule &&
      !out.includes(name)
    )
      out.push(name)
  }
  return out
}

// Imports of the package's own dependencies resolve to nothing in the virtual host, the same way in
// both versions. Worth a flag, not worth a full type check to find.
function hasUnresolvedImports(
  program: ts.Program,
  options: ts.CompilerOptions,
  host: ts.CompilerHost,
  pkg: string
): boolean {
  let checked = 0
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(`${PKG_ROOT}/`)) continue
    for (const imp of ts.preProcessFile(sf.text, true, true).importedFiles) {
      const name = imp.fileName
      if (name.startsWith(".") || name === pkg || name.startsWith(`${pkg}/`))
        continue
      if (++checked > 500) return false
      if (
        !ts.resolveModuleName(name, sf.fileName, options, host).resolvedModule
      )
        return true
    }
  }
  return false
}
