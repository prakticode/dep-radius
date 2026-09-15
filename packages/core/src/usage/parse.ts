import ts from "typescript"

import type { SourceText } from "./files.ts"
import type { Binding, ChainSeg } from "../model.ts"

// Everything the link phase needs from one file, as plain data: no ts.Node survives this module.

export interface Pos {
  line: number
  col: number
  text: string
}

export interface ImportBinding {
  local: string
  specifier: string
  binding: Binding
  typeOnly: boolean
  pos: Pos
}

export interface ReExport {
  specifier: string
  // star: export * from ; named: export { a as b } from ; star-as: export * as ns from
  kind: "star" | "named" | "star-as"
  names: { imported: string; exported: string }[]
  pos: Pos
}

export interface Reference {
  local: string
  chain: ChainSeg[]
  callSelf: boolean
  typeOnly: boolean
  pos: Pos
  // the bare binding is handed away: passed, assigned, returned, spread
  escape: boolean
  computed: boolean
  // `const x = <this reference>`: x is a derived binding
  derivedInto?: string
  // parameters of functions passed to a call in this chain: `app.get(path, (req, res) => ...)`
  callbackInto?: string[]
}

// require("p").a / (await import("p")).a / import("p").then(...) without a named binding
export interface InlineUse {
  specifier: string
  binding: Binding
  chain: ChainSeg[]
  callSelf: boolean
  pos: Pos
  escape: boolean
  derivedInto?: string
  callbackInto?: string[]
}

export interface FileFacts {
  imports: ImportBinding[]
  sideEffects: { specifier: string; pos: Pos }[]
  reExports: ReExport[]
  // `export { local as exported }` without from, and `export default local`
  exportedLocals: { local: string; exported: string }[]
  // names declared in this file and exported
  declaredExports: string[]
  references: Reference[]
  inline: InlineUse[]
  nonLiteralRequire: Pos[]
  nonLiteralImport: Pos[]
  prefixImports: { prefix: string; pos: Pos }[]
  stringLiterals: { value: string; pos: Pos }[]
  // the keys of object literals passed to the calls of a reference, by the reference's position:
  // `bodyParser.json({ limit })` passes `limit`; `at` holds where each key is written
  passedKeys: { line: number; col: number; keys: string[]; at: Pos[] }[]
  unparseable: boolean
}

export const SCANNER_VERSION = 4

export function parseSource(src: SourceText): FileFacts {
  const facts: FileFacts = {
    imports: [],
    sideEffects: [],
    reExports: [],
    exportedLocals: [],
    declaredExports: [],
    references: [],
    inline: [],
    nonLiteralRequire: [],
    nonLiteralImport: [],
    prefixImports: [],
    stringLiterals: [],
    passedKeys: [],
    unparseable: false,
  }
  for (const block of src.blocks) parseBlock(src.rel, block, facts)
  return facts
}

function scriptKind(kind: SourceText["blocks"][number]["kind"]): ts.ScriptKind {
  return kind === "ts"
    ? ts.ScriptKind.TS
    : kind === "tsx"
      ? ts.ScriptKind.TSX
      : kind === "jsx"
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS
}

function parseBlock(
  rel: string,
  block: SourceText["blocks"][number],
  facts: FileFacts
): void {
  // .js files routinely hold JSX; parsing them as JSX costs nothing when there is none
  const kind = block.kind === "js" ? "jsx" : block.kind
  const sf = ts.createSourceFile(
    rel,
    block.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(kind)
  )
  // parseDiagnostics is internal; the pinned TypeScript version keeps it stable (see test/unit/parse.test.ts)
  const diags = (sf as unknown as { parseDiagnostics?: unknown[] })
    .parseDiagnostics
  if (diags && diags.length > 0) facts.unparseable = true

  const lines = block.text.split("\n")
  const pos = (node: ts.Node): Pos => {
    const start = node.getStart(sf)
    const lc = sf.getLineAndCharacterOfPosition(start)
    const lineText = lines[lc.line] ?? ""
    return {
      line: lc.line + 1 + block.lineOffset,
      col: lc.character + 1,
      text: lineText.trim().slice(0, 160),
    }
  }

  const bindings = new Map<string, ImportBinding>()
  const add = (b: ImportBinding) => {
    facts.imports.push(b)
    bindings.set(b.local, b)
  }
  const handledCalls = new Set<ts.Node>()

  // ---------------------------------------------------------------- pass 1: declarations
  const visitDecl = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      const clause = node.importClause
      if (!clause) {
        facts.sideEffects.push({ specifier, pos: pos(node) })
      } else {
        const typeOnly = clause.isTypeOnly
        if (clause.name)
          add({
            local: clause.name.text,
            specifier,
            binding: { kind: "default" },
            typeOnly,
            pos: pos(clause.name),
          })
        const nb = clause.namedBindings
        if (nb && ts.isNamespaceImport(nb)) {
          add({
            local: nb.name.text,
            specifier,
            binding: { kind: "namespace" },
            typeOnly,
            pos: pos(nb),
          })
        } else if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = el.propertyName
              ? moduleExportName(el.propertyName)
              : el.name.text
            add({
              local: el.name.text,
              specifier,
              binding:
                imported === "default"
                  ? { kind: "default" }
                  : { kind: "named", imported },
              typeOnly: typeOnly || el.isTypeOnly,
              pos: pos(el),
            })
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expr = node.moduleReference.expression
      if (ts.isStringLiteral(expr)) {
        add({
          local: node.name.text,
          specifier: expr.text,
          binding: { kind: "cjs" },
          typeOnly: node.isTypeOnly,
          pos: pos(node),
        })
      }
    } else if (ts.isExportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined
      const clause = node.exportClause
      if (spec) {
        if (!clause)
          facts.reExports.push({
            specifier: spec,
            kind: "star",
            names: [],
            pos: pos(node),
          })
        else if (ts.isNamespaceExport(clause))
          facts.reExports.push({
            specifier: spec,
            kind: "star-as",
            names: [{ imported: "*", exported: moduleExportName(clause.name) }],
            pos: pos(node),
          })
        else
          facts.reExports.push({
            specifier: spec,
            kind: "named",
            names: clause.elements.map((el) => ({
              imported: el.propertyName
                ? moduleExportName(el.propertyName)
                : moduleExportName(el.name),
              exported: moduleExportName(el.name),
            })),
            pos: pos(node),
          })
      } else if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          facts.exportedLocals.push({
            local: el.propertyName
              ? moduleExportName(el.propertyName)
              : moduleExportName(el.name),
            exported: moduleExportName(el.name),
          })
        }
      }
    } else if (
      ts.isExportAssignment(node) &&
      ts.isIdentifier(node.expression)
    ) {
      facts.exportedLocals.push({
        local: node.expression.text,
        exported: "default",
      })
    } else if (ts.isVariableStatement(node) || isNamedDeclaration(node)) {
      const exported = hasExport(node)
      if (ts.isVariableStatement(node)) {
        if (exported)
          for (const d of node.declarationList.declarations)
            for (const n of bindingNames(d.name)) facts.declaredExports.push(n)
      } else if (exported) {
        const name = (node as ts.NamedDeclaration).name
        if (hasDefault(node)) facts.declaredExports.push("default")
        else if (name && ts.isIdentifier(name))
          facts.declaredExports.push(name.text)
      }
    } else if (ts.isExportAssignment(node)) {
      facts.declaredExports.push("default")
    }
    if (ts.isSourceFile(node) || ts.isModuleBlock(node))
      node.forEachChild(visitDecl)
  }
  sf.forEachChild(visitDecl)

  // CommonJS and awaited dynamic imports bound to a name, at any depth: `const { a } = require("p")`
  const visitRequires = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const req = requireOrImportCall(node.initializer)
      if (req && req.specifier !== undefined) {
        const d = node
        if (ts.isIdentifier(d.name)) {
          handledCalls.add(req.call)
          add({
            local: d.name.text,
            specifier: req.specifier,
            binding: req.dynamic ? { kind: "namespace" } : { kind: "cjs" },
            typeOnly: false,
            pos: pos(d),
          })
        } else if (ts.isObjectBindingPattern(d.name)) {
          handledCalls.add(req.call)
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name) || el.dotDotDotToken) continue
            const imported =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text
            add({
              local: el.name.text,
              specifier: req.specifier,
              binding:
                imported === "default"
                  ? { kind: "default" }
                  : { kind: "named", imported },
              typeOnly: false,
              pos: pos(el),
            })
          }
        }
      }
    }
    node.forEachChild(visitRequires)
  }
  sf.forEachChild(visitRequires)

  // ---------------------------------------------------------------- pass 2: references and inline uses
  const derived = new Map<string, true>()
  const recordPassed = (at: Pos, passed: Passed[]) => {
    if (passed.length > 0)
      facts.passedKeys.push({
        line: at.line,
        col: at.col,
        keys: passed.map((p) => p.name),
        at: passed.map((p) => pos(p.node)),
      })
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      bindings.has(node.text) &&
      isReferencePosition(node)
    ) {
      const ref = climb(node)
      const at = pos(node)
      const { passed, ...rest } = withoutBenign(ref)
      facts.references.push({ local: node.text, ...rest, pos: at })
      recordPassed(at, passed)
      if (ref.derivedInto) derived.set(ref.derivedInto, true)
      for (const cb of ref.callbackInto ?? []) derived.set(cb, true)
    } else if (ts.isCallExpression(node)) {
      handleCall(node)
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      if (
        !isModuleSpecifierPosition(node) &&
        node.text.length > 0 &&
        node.text.length < 200
      ) {
        facts.stringLiterals.push({ value: node.text, pos: pos(node) })
      }
    }
    node.forEachChild(visit)
  }

  const handleCall = (node: ts.CallExpression): void => {
    const isRequire =
      ts.isIdentifier(node.expression) && node.expression.text === "require"
    const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
    if (!isRequire && !isImport) return
    const arg = node.arguments[0]
    if (!arg) return
    const specifier =
      ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
        ? arg.text
        : undefined
    if (specifier === undefined) {
      if (
        ts.isTemplateExpression(arg) &&
        arg.head.text &&
        !arg.head.text.startsWith(".")
      ) {
        facts.prefixImports.push({ prefix: arg.head.text, pos: pos(node) })
      } else if (isRequire) facts.nonLiteralRequire.push(pos(node))
      else facts.nonLiteralImport.push(pos(node))
      return
    }
    if (handledCalls.has(node)) return
    // climb from the call: require("p").a.b() / (await import("p")).a
    let cur: ts.Node = node
    if (isImport && ts.isAwaitExpression(cur.parent)) cur = cur.parent
    while (ts.isParenthesizedExpression(cur.parent)) cur = cur.parent
    const r = climbFrom(cur)
    const binding: Binding = isImport ? { kind: "namespace" } : { kind: "cjs" }
    recordPassed(pos(node), r.passed)
    const parent = cur.parent
    if (
      r.chain.length === 0 &&
      !r.callSelf &&
      parent &&
      ts.isExpressionStatement(parent)
    ) {
      facts.sideEffects.push({ specifier, pos: pos(node) })
      return
    }
    facts.inline.push({
      specifier,
      binding,
      chain: r.chain,
      callSelf: r.callSelf,
      pos: pos(node),
      escape: r.chain.length === 0 && !r.callSelf && !r.computed,
      ...(r.derivedInto ? { derivedInto: r.derivedInto } : {}),
      ...(r.callbackInto ? { callbackInto: r.callbackInto } : {}),
    })
    if (r.derivedInto) derived.set(r.derivedInto, true)
    for (const cb of r.callbackInto ?? []) derived.set(cb, true)
  }

  const climb = (id: ts.Identifier) => {
    const r = climbFrom(id)
    const b = bindings.get(id.text)!
    const bare = r.chain.length === 0 && !r.callSelf && !r.computed
    const typeOnly = r.typeOnly || b.typeOnly
    return {
      ...r,
      typeOnly,
      escape: bare && b.binding.kind !== "named" && !r.benign,
    }
  }
  sf.forEachChild(visit)

  // derived bindings: `const app = createApp()`, then `app.use(...)`. Two more rounds reach `const r = app.route()`.
  let frontier = new Set(derived.keys())
  const seen = new Set<string>()
  for (let round = 0; round < 3 && frontier.size > 0; round++) {
    const names = new Set(
      [...frontier].filter((n) => !bindings.has(n) && !seen.has(n))
    )
    for (const n of names) seen.add(n)
    const next = new Set<string>()
    const visitDerived = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        isReferencePosition(node)
      ) {
        const r = climbFrom(node)
        if (r.chain.length > 0 || r.callSelf) {
          recordPassed(pos(node), r.passed)
          facts.references.push({
            local: node.text,
            chain: r.chain,
            callSelf: r.callSelf,
            typeOnly: r.typeOnly,
            pos: pos(node),
            escape: false,
            computed: r.computed,
            ...(r.derivedInto ? { derivedInto: r.derivedInto } : {}),
            ...(r.callbackInto ? { callbackInto: r.callbackInto } : {}),
          })
          if (r.derivedInto) next.add(r.derivedInto)
          for (const cb of r.callbackInto ?? []) next.add(cb)
        }
      }
      node.forEachChild(visitDerived)
    }
    if (names.size > 0) sf.forEachChild(visitDerived)
    frontier = next
  }
}

interface Climb {
  chain: ChainSeg[]
  callSelf: boolean
  typeOnly: boolean
  computed: boolean
  derivedInto?: string
  callbackInto?: string[]
  // bare use that does not hide which member is used: JSX tag, class heritage, typeof import, export specifier
  benign: boolean
  passed: Passed[]
}

// a key of an object literal passed to a call, and where it is written
interface Passed {
  name: string
  node: ts.Node
}

function climbFrom(start: ts.Node): Climb {
  const chain: ChainSeg[] = []
  let callSelf = false
  let typeOnly = false
  let computed = false
  let benign = false
  const callbacks: string[] = []
  const passed = new Map<string, ts.Node>()
  let cur: ts.Node = start
  for (;;) {
    const p: ts.Node = cur.parent
    if (!p) break
    if (
      (ts.isParenthesizedExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isSatisfiesExpression(p)) &&
      p.expression === cur
    ) {
      cur = p
    } else if (ts.isAwaitExpression(p)) {
      cur = p
    } else if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
      if (ts.isIdentifier(p.name))
        chain.push({ name: p.name.text, call: false })
      cur = p
    } else if (ts.isElementAccessExpression(p) && p.expression === cur) {
      const a = p.argumentExpression
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
        chain.push({ name: a.text, call: false })
        cur = p
      } else {
        computed = true
        break
      }
    } else if (
      (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
      p.expression === cur
    ) {
      for (const arg of p.arguments ?? []) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
          for (const param of arg.parameters)
            callbacks.push(...bindingNames(param.name))
        if (ts.isObjectLiteralExpression(arg))
          for (const prop of arg.properties) {
            const name = prop.name && propertyName(prop.name)
            if (name && !passed.has(name)) passed.set(name, prop)
          }
      }
      const last = chain[chain.length - 1]
      const construct = ts.isNewExpression(p)
      if (last) {
        last.call = true
        if (construct) last.construct = true
      } else callSelf = true
      cur = p
    } else if (ts.isTaggedTemplateExpression(p) && p.tag === cur) {
      const last = chain[chain.length - 1]
      if (last) last.call = true
      else callSelf = true
      cur = p
    } else if (ts.isQualifiedName(p) && p.left === cur) {
      chain.push({ name: p.right.text, call: false })
      typeOnly = true
      cur = p
    } else if (
      ts.isTypeReferenceNode(p) ||
      ts.isExpressionWithTypeArguments(p)
    ) {
      if (ts.isTypeReferenceNode(p)) typeOnly = true
      if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent))
        benign = true
      if (ts.isTypeReferenceNode(p)) benign = true
      break
    } else if (ts.isTypeQueryNode(p)) {
      typeOnly = true
      break
    } else if (
      (ts.isJsxOpeningElement(p) ||
        ts.isJsxSelfClosingElement(p) ||
        ts.isJsxClosingElement(p)) &&
      p.tagName === cur
    ) {
      if (chain.length === 0) callSelf = true
      else chain[chain.length - 1]!.call = true
      benign = true
      break
    } else if (ts.isExportSpecifier(p) || ts.isExportAssignment(p)) {
      benign = true
      break
    } else if (ts.isHeritageClause(p)) {
      benign = true
      break
    } else {
      break
    }
  }
  let derivedInto: string | undefined
  if ((chain.length > 0 || callSelf) && !typeOnly) {
    const p = cur.parent
    if (
      p &&
      ts.isVariableDeclaration(p) &&
      p.initializer === cur &&
      ts.isIdentifier(p.name)
    )
      derivedInto = p.name.text
  }
  return {
    chain,
    callSelf,
    typeOnly,
    computed,
    benign,
    passed: [...passed].map(([name, node]) => ({ name, node })),
    ...(derivedInto ? { derivedInto } : {}),
    ...(callbacks.length > 0 ? { callbackInto: [...new Set(callbacks)] } : {}),
  }
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined
}

function withoutBenign<T extends { benign: boolean }>(r: T): Omit<T, "benign"> {
  const { benign: _b, ...rest } = r
  return rest
}

function isReferencePosition(node: ts.Identifier): boolean {
  const p = node.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false
  if (ts.isQualifiedName(p) && p.right === node) return false
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isEnumDeclaration(p) ||
      ts.isModuleDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isTypeParameterDeclaration(p) ||
      ts.isJsxAttribute(p) ||
      ts.isLabeledStatement(p) ||
      ts.isBreakOrContinueStatement(p) ||
      ts.isPropertySignature(p)) &&
    (p as ts.NamedDeclaration).name === node
  )
    return false
  if (ts.isBindingElement(p) && (p.name === node || p.propertyName === node))
    return false
  if (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isImportEqualsDeclaration(p) ||
    ts.isNamespaceExport(p)
  )
    return false
  if (ts.isExportSpecifier(p) && p.parent.parent.moduleSpecifier) return false
  if (ts.isImportTypeNode(p)) return false
  return true
}

function isModuleSpecifierPosition(node: ts.Node): boolean {
  const p = node.parent
  if (!p) return false
  if (
    (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) &&
    p.moduleSpecifier === node
  )
    return true
  if (ts.isExternalModuleReference(p)) return true
  if (
    ts.isCallExpression(p) &&
    (p.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(p.expression) && p.expression.text === "require"))
  )
    return true
  if (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) return true
  return false
}

function requireOrImportCall(
  init: ts.Expression | undefined
):
  | { call: ts.CallExpression; specifier: string | undefined; dynamic: boolean }
  | undefined {
  let e = init
  let awaited = false
  while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e))) {
    if (ts.isAwaitExpression(e)) awaited = true
    e = e.expression
  }
  if (!e || !ts.isCallExpression(e)) return undefined
  const isRequire =
    ts.isIdentifier(e.expression) && e.expression.text === "require"
  const isImport = e.expression.kind === ts.SyntaxKind.ImportKeyword && awaited
  if (!isRequire && !isImport) return undefined
  const arg = e.arguments[0]
  const specifier =
    arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ? arg.text
      : undefined
  return { call: e, specifier, dynamic: isImport }
}

function moduleExportName(n: ts.ModuleExportName): string {
  return n.text
}

function isNamedDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  )
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function hasDefault(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts
      .getModifiers(node)
      ?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  )
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const out: string[] = []
  for (const el of name.elements)
    if (!ts.isOmittedExpression(el)) out.push(...bindingNames(el.name))
  return out
}
