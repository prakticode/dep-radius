import ts from "typescript"

import { sha1 } from "../../infra/hash.ts"
import type { ImplementationUnit } from "./model.ts"

// What a module export stands for, before the other modules are known.
export type ExportTarget =
  | { kind: "local"; name: string }
  | { kind: "unit"; unit: number }
  | { kind: "import"; spec: string; name: string }
  | { kind: "namespace"; spec: string }
  // `foo_1.bar`, the way compiled CommonJS reads a name from another module
  | { kind: "member"; object: string; name: string }

// name "*" is the whole module: `import * as m`, `const m = require("./m")`
export interface ImportBinding {
  spec: string
  name: string
}

export type UnitRef =
  // use: "member" for the object of `name.member`, which the member reference resolves more
  // precisely; "call" for `name()` and `new name()`; none when the value itself is handed on
  | { kind: "id"; name: string; use?: "member" | "call" }
  | { kind: "member"; object?: string; name: string }
  | { kind: "module"; spec: string }

export interface ParsedUnit {
  name: string
  kind: ImplementationUnit["kind"]
  parent: number | undefined
  // units that run, or are handed out, when this one runs: nested functions and object members,
  // never a class's methods, which run only when called by name
  children: number[]
  // named functions, classes and values declared directly inside, visible to its code
  scope: Map<string, number>
  // `#name` instance and `.name` static methods of a class, `.name` members of an object value
  members: Map<string, number>
  // members that name a value defined elsewhere (`{ parse }`, `obj.isEmail = _isEmail.default`),
  // resolved once every module is read
  memberTargets: Map<string, ExportTarget>
  // for a method, the class or object whose members `this.name` reads
  owner?: number
  refs: UnitRef[]
  fp: string
}

export interface ParsedModule {
  file: string
  units: ParsedUnit[]
  top: Map<string, number>
  imports: Map<string, ImportBinding>
  exports: Map<string, ExportTarget>
  // `export * from`, `__exportStar(require("./x"), exports)`
  stars: string[]
  // `module.exports = x`: what the module itself is when called or constructed
  self: ExportTarget | undefined
  minified: boolean
  unparseable: boolean
  // syntax nodes visited: a deterministic stand-in for time
  work: number
}

const FIRST_JSDOC = ts.SyntaxKind.FirstJSDocNode
const LAST_JSDOC = ts.SyntaxKind.LastJSDocNode

function skipOuter(e: ts.Expression): ts.Expression {
  let cur = e
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression
    // `(0, m.fn)` calls fn without a receiver: the name is what matters
    else if (
      ts.isBinaryExpression(cur) &&
      cur.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
      cur = cur.right
    else return cur
  }
}

function requireSpec(e: ts.Expression): string | undefined {
  const x = skipOuter(e)
  if (!ts.isCallExpression(x)) return undefined
  const arg = x.arguments[0]
  if (
    ts.isIdentifier(x.expression) &&
    x.expression.text === "require" &&
    arg &&
    ts.isStringLiteralLike(arg)
  )
    return arg.text
  // `__importDefault(require("./x"))`, `__toESM(require("./x"))`: interop around a require
  if (x.arguments.length === 1 && arg) return requireSpec(arg)
  return undefined
}

function isModuleExports(e: ts.Expression): boolean {
  const x = skipOuter(e)
  return (
    ts.isPropertyAccessExpression(x) &&
    ts.isIdentifier(x.expression) &&
    x.expression.text === "module" &&
    x.name.text === "exports"
  )
}

function isExportsObject(e: ts.Expression): boolean {
  const x = skipOuter(e)
  return (ts.isIdentifier(x) && x.text === "exports") || isModuleExports(x)
}

function propName(n: ts.PropertyName | undefined): string | undefined {
  if (!n) return undefined
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text
  if (ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) return n.text
  return undefined
}

function isFunctionLike(
  e: ts.Node | undefined
): e is ts.FunctionExpression | ts.ArrowFunction {
  return !!e && (ts.isFunctionExpression(e) || ts.isArrowFunction(e))
}

function isReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p)) return p.expression === id
  if (
    ts.isPropertyAssignment(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isPropertySignature(p)
  )
    return p.name !== id
  if (ts.isBindingElement(p)) return p.name !== id && p.propertyName !== id
  if (
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p)
  )
    return p.name !== id
  if (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p) ||
    ts.isJsxAttribute(p)
  )
    return false
  return true
}

export function parseModule(
  file: string,
  text: string,
  workBudget: number
): ParsedModule {
  const sf = ts.createSourceFile(
    `/pkg/${file}`,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  )
  const lines = text.split("\n").length
  const mod: ParsedModule = {
    file,
    units: [],
    top: new Map(),
    imports: new Map(),
    exports: new Map(),
    stars: [],
    self: undefined,
    // long lines in a big file: names are mangled, and differ between builds of the same source
    minified: text.length > 4000 && text.length / lines > 400,
    // not in the public API, and the only way to tell a file the parser gave up on
    unparseable:
      ((sf as ts.SourceFile & { parseDiagnostics?: readonly unknown[] })
        .parseDiagnostics?.length ?? 0) > 0,
    work: 0,
  }
  const nodes = new Map<ts.Node, number>()
  const out = () => mod.work > workBudget
  // `{ config }`, `{ parse: parseImpl }`, `obj.key = name`: members that name a module-level unit,
  // resolved once every declaration is known
  const aliases: { owner: string; key: string; target: ExportTarget }[] = []
  // a value that only names another: `parse`, `_isEmail.default`, `exports.default`
  const namedValue = (e: ts.Expression): ExportTarget | undefined => {
    const x = skipOuter(e)
    if (ts.isIdentifier(x)) return { kind: "local", name: x.text }
    if (ts.isPropertyAccessExpression(x)) {
      const inner = skipOuter(x.expression)
      if (isExportsObject(inner))
        return { kind: "member", object: "exports", name: x.name.text }
      if (ts.isIdentifier(inner))
        return { kind: "member", object: inner.text, name: x.name.text }
    }
    return undefined
  }
  const factoryReturns: ts.Expression[] = []
  const wrapperParams = new Set<string>()

  const addUnit = (
    name: string,
    kind: ParsedUnit["kind"],
    node: ts.Node,
    parent: number | undefined,
    opts: { scoped: boolean; contained: boolean }
  ): number => {
    const id = mod.units.length
    mod.units.push({
      name,
      kind,
      parent,
      children: [],
      scope: new Map(),
      members: new Map(),
      memberTargets: new Map(),
      refs: [],
      fp: "",
    })
    nodes.set(node, id)
    if (opts.scoped) {
      if (parent === undefined) mod.top.set(name, id)
      else {
        const short = name.slice(name.lastIndexOf("/") + 1)
        mod.units[parent]!.scope.set(short, id)
      }
    }
    if (opts.contained && parent !== undefined)
      mod.units[parent]!.children.push(id)
    return id
  }
  const qualify = (parent: number | undefined, name: string) =>
    parent === undefined ? name : `${mod.units[parent]!.name}/${name}`

  const visitChildren = (node: ts.Node, cur: number | undefined) =>
    ts.forEachChild(node, (c) => {
      visit(c, cur)
    })

  const classUnit = (
    name: string,
    node: ts.ClassLikeDeclaration,
    cur: number | undefined,
    scoped = true
  ): number => {
    const u = addUnit(qualify(cur, name), "class", node, cur, {
      scoped,
      contained: true,
    })
    const cname = mod.units[u]!.name
    for (const h of node.heritageClauses ?? []) visit(h, u)
    for (const m of node.members) {
      const key = propName(m.name)
      const isStatic = !!ts
        .getModifiers(m as ts.HasModifiers)
        ?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword)
      const sep = isStatic ? "." : "#"
      const fnNode =
        (ts.isMethodDeclaration(m) ||
          ts.isGetAccessorDeclaration(m) ||
          ts.isSetAccessorDeclaration(m)) &&
        m.body
          ? m
          : ts.isPropertyDeclaration(m) && isFunctionLike(m.initializer)
            ? m.initializer
            : undefined
      if (key !== undefined && fnNode) {
        const mu = addUnit(`${cname}${sep}${key}`, "method", fnNode, u, {
          scoped: false,
          contained: false,
        })
        mod.units[mu]!.owner = u
        // a getter and a setter share a name: the first one keeps the member slot
        if (!mod.units[u]!.members.has(`${sep}${key}`))
          mod.units[u]!.members.set(`${sep}${key}`, mu)
        visitChildren(fnNode, mu)
      } else visit(m, u)
    }
    return u
  }

  const objectMembers = (
    obj: ts.ObjectLiteralExpression,
    owner: number,
    prefix: string,
    memberSlots: boolean
  ) => {
    for (const p of obj.properties) {
      const key = propName(p.name)
      const fnNode =
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p)
          ? p
          : ts.isPropertyAssignment(p) && isFunctionLike(p.initializer)
            ? p.initializer
            : undefined
      if (key !== undefined && fnNode) {
        const mu = addUnit(`${prefix}${key}`, "method", fnNode, owner, {
          scoped: false,
          contained: true,
        })
        if (memberSlots) {
          mod.units[owner]!.members.set(`.${key}`, mu)
          mod.units[mu]!.owner = owner
        }
        visitChildren(fnNode, mu)
        continue
      }
      if (memberSlots && key !== undefined) {
        const target = ts.isShorthandPropertyAssignment(p)
          ? { kind: "local" as const, name: p.name.text }
          : ts.isPropertyAssignment(p)
            ? namedValue(p.initializer)
            : undefined
        if (target) aliases.push({ owner: mod.units[owner]!.name, key, target })
      }
      visit(p, owner)
    }
  }

  const scoped = (cur: number | undefined, name: string) => {
    for (let p = cur; p !== undefined; p = mod.units[p]!.parent) {
      const hit = mod.units[p]!.scope.get(name)
      if (hit !== undefined) return hit
    }
    return mod.top.get(name)
  }

  // `Foo.prototype.bar = function` and `Foo.bar = function`: the classes of ES5 output, which
  // would otherwise be one unit as large as the class
  const prototypeMethod = (node: ts.Node, cur: number | undefined): boolean => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    )
      return false
    // `req.login = req.logIn = function`: one function under every name of the chain
    const lefts: ts.Expression[] = [node.left]
    let right = skipOuter(node.right)
    while (
      ts.isBinaryExpression(right) &&
      right.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      lefts.push(right.left)
      right = skipOuter(right.right)
    }
    if (!isFunctionLike(right)) return false
    const slots: { ownerName: string; owner: number; key: string }[] = []
    for (const left of lefts) {
      if (!ts.isPropertyAccessExpression(left)) continue
      const target = left.expression
      let ownerName: string | undefined
      let sep = "."
      if (
        ts.isPropertyAccessExpression(target) &&
        target.name.text === "prototype" &&
        ts.isIdentifier(target.expression)
      ) {
        ownerName = target.expression.text
        sep = "#"
      } else if (ts.isIdentifier(target)) ownerName = target.text
      const owner = ownerName !== undefined ? scoped(cur, ownerName) : undefined
      if (ownerName !== undefined && owner !== undefined)
        slots.push({ ownerName, owner, key: `${sep}${left.name.text}` })
    }
    const first = slots[0]
    if (!first) return false
    const mu = addUnit(`${first.ownerName}${first.key}`, "method", right, cur, {
      scoped: false,
      contained: false,
    })
    mod.units[mu]!.owner = first.owner
    for (const s of slots) {
      mod.units[s.owner]!.members.set(s.key, mu)
      // the IIFE around an ES5 class is the unit other modules name
      for (let p = cur; p !== undefined; p = mod.units[p]!.parent)
        if (mod.units[p]!.name === s.ownerName)
          mod.units[p]!.members.set(s.key, mu)
    }
    visitChildren(right, mu)
    return true
  }

  const visit = (node: ts.Node, cur: number | undefined): void => {
    mod.work++
    if (out()) return
    if (node.kind >= FIRST_JSDOC && node.kind <= LAST_JSDOC) return
    if (ts.isFunctionDeclaration(node) && node.name) {
      const u = addUnit(qualify(cur, node.name.text), "function", node, cur, {
        scoped: true,
        contained: true,
      })
      visitChildren(node, u)
      return
    }
    if (ts.isClassDeclaration(node) && node.name) {
      classUnit(node.name.text, node, cur)
      return
    }
    if (prototypeMethod(node, cur)) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const init = node.initializer
      const name = node.name.text
      if (isFunctionLike(init)) {
        const u = addUnit(qualify(cur, name), "function", init, cur, {
          scoped: true,
          contained: true,
        })
        visitChildren(init, u)
        return
      }
      if (ts.isClassExpression(init)) {
        classUnit(name, init, cur)
        return
      }
      // module-level values are units too: a changed constant changes every function reading it
      if (cur === undefined) {
        const u = addUnit(name, "value", init, cur, {
          scoped: true,
          contained: false,
        })
        if (ts.isObjectLiteralExpression(skipOuter(init)))
          objectMembers(
            skipOuter(init) as ts.ObjectLiteralExpression,
            u,
            `${name}.`,
            true
          )
        else visit(init, u)
        return
      }
    }
    if (cur !== undefined) {
      if (ts.isObjectLiteralExpression(node)) {
        objectMembers(node, cur, `${mod.units[cur]!.name}/`, false)
        return
      }
      if (ts.isCallExpression(node)) {
        const arg = node.arguments[0]
        if (
          arg &&
          ts.isStringLiteralLike(arg) &&
          ((ts.isIdentifier(node.expression) &&
            node.expression.text === "require") ||
            node.expression.kind === ts.SyntaxKind.ImportKeyword)
        )
          mod.units[cur]!.refs.push({ kind: "module", spec: arg.text })
      }
      if (ts.isPropertyAccessExpression(node)) {
        const obj = skipOuter(node.expression)
        mod.units[cur]!.refs.push({
          kind: "member",
          ...(ts.isIdentifier(obj)
            ? { object: obj.text }
            : obj.kind === ts.SyntaxKind.ThisKeyword
              ? { object: "this" }
              : {}),
          name: node.name.text,
        })
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const obj = skipOuter(node.expression)
        mod.units[cur]!.refs.push({
          kind: "member",
          ...(ts.isIdentifier(obj) ? { object: obj.text } : {}),
          name: node.argumentExpression.text,
        })
      } else if (ts.isIdentifier(node) && isReference(node)) {
        const p = node.parent
        const use =
          (ts.isPropertyAccessExpression(p) ||
            (ts.isElementAccessExpression(p) &&
              ts.isStringLiteralLike(p.argumentExpression))) &&
          p.expression === node
            ? "member"
            : (ts.isNewExpression(p) || ts.isCallExpression(p)) &&
                p.expression === node
              ? "call"
              : undefined
        mod.units[cur]!.refs.push({
          kind: "id",
          name: node.text,
          ...(use ? { use } : {}),
        })
      }
    }
    visitChildren(node, cur)
  }

  // The value an export names. Inline code becomes a unit named after the export.
  const targetOf = (
    e: ts.Expression,
    hint: string
  ): ExportTarget | undefined => {
    const x = skipOuter(e)
    if (ts.isIdentifier(x))
      return x.text === "undefined"
        ? undefined
        : { kind: "local", name: x.text }
    if (ts.isVoidExpression(x)) return undefined
    const spec = requireSpec(x)
    if (spec !== undefined) return { kind: "namespace", spec }
    if (ts.isPropertyAccessExpression(x)) {
      const inner = skipOuter(x.expression)
      const s = requireSpec(inner)
      if (s !== undefined) return { kind: "import", spec: s, name: x.name.text }
      const named = namedValue(x)
      if (named) return named
    }
    if (isFunctionLike(x)) {
      const u = addUnit(hint, "function", x, undefined, {
        scoped: false,
        contained: false,
      })
      visitChildren(x, u)
      return { kind: "unit", unit: u }
    }
    // a class expression assigned to an export is not a name the module's code can see
    if (ts.isClassExpression(x))
      return { kind: "unit", unit: classUnit(hint, x, undefined, false) }
    const u = addUnit(hint, "value", x, undefined, {
      scoped: false,
      contained: false,
    })
    if (ts.isObjectLiteralExpression(x)) objectMembers(x, u, `${hint}.`, true)
    else visit(x, u)
    return { kind: "unit", unit: u }
  }

  const setExport = (name: string, t: ExportTarget | undefined) => {
    // `module.exports.default = exports.default` says nothing new
    if (
      !t ||
      (t.kind === "member" && t.object === "exports" && t.name === name)
    )
      return
    mod.exports.set(name, t)
  }

  const hasExportModifier = (s: ts.Statement) =>
    !!ts
      .getModifiers(s as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const hasDefaultModifier = (s: ts.Statement) =>
    !!ts
      .getModifiers(s as ts.HasModifiers)
      ?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)

  const topStatements = (stmts: readonly ts.Statement[], depth: number) => {
    for (const s of stmts) {
      if (out()) return
      topStatement(s, depth)
    }
  }

  const topCall = (call: ts.CallExpression, depth: number): boolean => {
    const callee = skipOuter(call.expression)
    // IIFE and UMD wrappers: their bodies are the module
    const bodyOf = (f: ts.Expression) => {
      const g = skipOuter(f)
      return isFunctionLike(g) && g.body && ts.isBlock(g.body)
        ? g.body
        : undefined
    }
    if (depth < 3) {
      let wrapped = false
      const direct =
        bodyOf(callee) ??
        (ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "call" || callee.name.text === "apply")
          ? bodyOf(callee.expression)
          : undefined)
      if (direct) {
        const wrapper = direct.parent as
          ts.FunctionExpression | ts.ArrowFunction
        for (const param of wrapper.parameters)
          if (ts.isIdentifier(param.name)) wrapperParams.add(param.name.text)
        topStatements(direct.statements, depth + 1)
        wrapped = true
      }
      for (const a of call.arguments) {
        const b = bodyOf(a)
        if (b) {
          topStatements(b.statements, depth + 1)
          // a UMD factory's result is what the wrapper assigns to module.exports
          const ret = b.statements.filter(ts.isReturnStatement).at(-1)
          if (ret?.expression) factoryReturns.push(ret.expression)
          wrapped = true
        }
      }
      if (wrapped) return true
    }
    // Object.defineProperty(exports, "name", { get: function () { return m.name } })
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "defineProperty" &&
      call.arguments.length >= 3 &&
      isExportsObject(call.arguments[0]!) &&
      ts.isStringLiteralLike(call.arguments[1]!) &&
      ts.isObjectLiteralExpression(call.arguments[2]!)
    ) {
      const name = call.arguments[1].text
      // the interop marker of compiled ESM, not an API
      if (name === "__esModule") return true
      for (const p of call.arguments[2].properties) {
        const key = propName(p.name)
        if (key === "value" && ts.isPropertyAssignment(p))
          setExport(name, targetOf(p.initializer, name))
        if (key !== "get") continue
        const fn = ts.isPropertyAssignment(p)
          ? skipOuter(p.initializer)
          : ts.isMethodDeclaration(p)
            ? p
            : undefined
        const body =
          fn && (isFunctionLike(fn) || ts.isMethodDeclaration(fn))
            ? fn.body
            : undefined
        const ret =
          body && ts.isBlock(body)
            ? body.statements.find(ts.isReturnStatement)?.expression
            : body
        if (ret) setExport(name, targetOf(ret, name))
        // `get: makeGetter("json")`: the getter is built by code, which is then the export
        else if (ts.isPropertyAssignment(p) && !body)
          setExport(name, targetOf(p.initializer, name))
      }
      return true
    }
    // __exportStar(require("./x"), exports), __reExport(target, require("./x"), module.exports)
    if (call.arguments.some(isExportsObject)) {
      let found = false
      for (const a of call.arguments) {
        const s = requireSpec(a)
        if (s !== undefined) {
          mod.stars.push(s)
          found = true
        }
      }
      if (found) return true
    }
    // __export(target, { name: () => local }): the export table of esbuild's CommonJS output
    const table = call.arguments[1]
    if (
      call.arguments.length === 2 &&
      table &&
      ts.isObjectLiteralExpression(table) &&
      table.properties.length > 0 &&
      table.properties.every(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isArrowFunction(p.initializer) &&
          !ts.isBlock(p.initializer.body)
      )
    ) {
      for (const p of table.properties) {
        const key = propName(p.name)
        const init = (p as ts.PropertyAssignment)
          .initializer as ts.ArrowFunction
        if (key !== undefined)
          setExport(key, targetOf(init.body as ts.Expression, key))
      }
      return true
    }
    return false
  }

  const topAssignment = (b: ts.BinaryExpression, depth: number) => {
    const left = skipOuter(b.left)
    const right = skipOuter(b.right)
    // `exports.b = exports.a = void 0`
    if (
      ts.isBinaryExpression(right) &&
      right.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
      topAssignment(right, depth)
    if (isModuleExports(left)) {
      if (ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          if (ts.isSpreadAssignment(p)) {
            const s = requireSpec(p.expression)
            if (s !== undefined) mod.stars.push(s)
            continue
          }
          const key = propName(p.name)
          if (key === undefined) continue
          if (ts.isShorthandPropertyAssignment(p))
            setExport(key, { kind: "local", name: key })
          else if (ts.isPropertyAssignment(p))
            setExport(key, targetOf(p.initializer, key))
          else if (ts.isMethodDeclaration(p)) {
            const u = addUnit(key, "method", p, undefined, {
              scoped: false,
              contained: false,
            })
            visitChildren(p, u)
            setExport(key, { kind: "unit", unit: u })
          }
        }
        return
      }
      // `module.exports = factory()` inside a UMD wrapper: the factory's result, read below
      if (
        ts.isCallExpression(right) &&
        ts.isIdentifier(right.expression) &&
        wrapperParams.has(right.expression.text)
      )
        return
      const s = requireSpec(right)
      if (s !== undefined) mod.stars.push(s)
      mod.self = targetOf(right, "exports")
      return
    }
    if (
      ts.isPropertyAccessExpression(left) &&
      isExportsObject(left.expression)
    ) {
      const t =
        ts.isBinaryExpression(right) &&
        right.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? targetOf(right.right, left.name.text)
          : targetOf(right, left.name.text)
      setExport(left.name.text, t)
      return
    }
    // `Papa.parse = CsvToJson`: a named function becomes a member of a module-level object
    const named = namedValue(right)
    if (
      ts.isPropertyAccessExpression(left) &&
      ts.isIdentifier(left.expression) &&
      named
    )
      aliases.push({
        owner: left.expression.text,
        key: left.name.text,
        target: named,
      })
    visit(b, undefined)
  }

  const topStatement = (s: ts.Statement, depth: number) => {
    // `if (process.env.X) module.exports = a; else module.exports = b`: both are the module
    if (depth < 3 && (ts.isIfStatement(s) || ts.isBlock(s))) {
      if (ts.isBlock(s)) topStatements(s.statements, depth + 1)
      else {
        visit(s.expression, undefined)
        topStatement(s.thenStatement, depth + 1)
        if (s.elseStatement) topStatement(s.elseStatement, depth + 1)
      }
      return
    }
    if (ts.isImportDeclaration(s)) {
      if (!ts.isStringLiteralLike(s.moduleSpecifier)) return
      const spec = s.moduleSpecifier.text
      const clause = s.importClause
      if (clause?.name)
        mod.imports.set(clause.name.text, { spec, name: "default" })
      const nb = clause?.namedBindings
      if (nb && ts.isNamespaceImport(nb))
        mod.imports.set(nb.name.text, { spec, name: "*" })
      else if (nb)
        for (const el of nb.elements)
          mod.imports.set(el.name.text, {
            spec,
            name: (el.propertyName ?? el.name).text,
          })
      return
    }
    if (ts.isExportDeclaration(s)) {
      const spec =
        s.moduleSpecifier && ts.isStringLiteralLike(s.moduleSpecifier)
          ? s.moduleSpecifier.text
          : undefined
      const clause = s.exportClause
      if (!clause) {
        if (spec !== undefined) mod.stars.push(spec)
      } else if (ts.isNamespaceExport(clause)) {
        if (spec !== undefined)
          mod.exports.set(clause.name.text, { kind: "namespace", spec })
      } else
        for (const el of clause.elements) {
          const local = (el.propertyName ?? el.name).text
          mod.exports.set(
            el.name.text,
            spec !== undefined
              ? { kind: "import", spec, name: local }
              : { kind: "local", name: local }
          )
        }
      return
    }
    if (ts.isExportAssignment(s)) {
      const t = targetOf(s.expression, "default")
      if (s.isExportEquals) mod.self = t
      else setExport("default", t)
      return
    }
    if (
      (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) &&
      hasExportModifier(s)
    ) {
      const isDefault = hasDefaultModifier(s)
      if (!s.name) {
        const u = ts.isClassDeclaration(s)
          ? classUnit("default", s, undefined)
          : addUnit("default", "function", s, undefined, {
              scoped: false,
              contained: false,
            })
        if (ts.isFunctionDeclaration(s)) visitChildren(s, u)
        setExport("default", { kind: "unit", unit: u })
        return
      }
      visit(s, undefined)
      setExport(isDefault ? "default" : s.name.text, {
        kind: "local",
        name: s.name.text,
      })
      return
    }
    if (ts.isVariableStatement(s)) {
      const exported = hasExportModifier(s)
      for (const d of s.declarationList.declarations) {
        const init = d.initializer
        const spec = init ? requireSpec(init) : undefined
        if (spec !== undefined && ts.isIdentifier(d.name)) {
          mod.imports.set(d.name.text, { spec, name: "*" })
          continue
        }
        if (init && ts.isObjectBindingPattern(d.name)) {
          const s2 = requireSpec(init)
          if (s2 !== undefined) {
            for (const el of d.name.elements)
              if (ts.isIdentifier(el.name))
                mod.imports.set(el.name.text, {
                  spec: s2,
                  name: propName(el.propertyName) ?? el.name.text,
                })
            continue
          }
        }
        // `var _default = exports.default = validator`, as Babel writes a default export
        const assigned = init ? skipOuter(init) : undefined
        if (
          assigned &&
          ts.isBinaryExpression(assigned) &&
          assigned.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          topAssignment(assigned, depth)
          continue
        }
        // export const { program, Command } = commander
        if (
          exported &&
          init &&
          ts.isObjectBindingPattern(d.name) &&
          ts.isIdentifier(skipOuter(init))
        ) {
          const object = (skipOuter(init) as ts.Identifier).text
          for (const el of d.name.elements)
            if (ts.isIdentifier(el.name))
              setExport(el.name.text, {
                kind: "member",
                object,
                name: propName(el.propertyName) ?? el.name.text,
              })
          continue
        }
        const pa = init ? skipOuter(init) : undefined
        if (
          pa &&
          ts.isPropertyAccessExpression(pa) &&
          ts.isIdentifier(d.name)
        ) {
          const s3 = requireSpec(pa.expression)
          if (s3 !== undefined) {
            mod.imports.set(d.name.text, { spec: s3, name: pa.name.text })
            continue
          }
        }
        visit(d, undefined)
        if (exported && ts.isIdentifier(d.name))
          setExport(d.name.text, { kind: "local", name: d.name.text })
      }
      return
    }
    if (ts.isExpressionStatement(s)) {
      let e = skipOuter(s.expression)
      // `!function () { ... }()`
      if (ts.isPrefixUnaryExpression(e)) e = skipOuter(e.operand)
      else if (ts.isVoidExpression(e)) e = skipOuter(e.expression)
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        topAssignment(e, depth)
        return
      }
      if (ts.isCallExpression(e) && topCall(e, depth)) return
    }
    visit(s, undefined)
  }

  topStatements(sf.statements, 0)
  const self = mod.self
  const selfUnknown =
    !self ||
    (self.kind === "local" &&
      !mod.top.has(self.name) &&
      !mod.imports.has(self.name))
  const factoryResult = factoryReturns.at(-1)
  if (selfUnknown && mod.exports.size === 0 && factoryResult)
    mod.self = targetOf(factoryResult, "exports")
  for (const a of aliases) {
    const owner = mod.units[mod.top.get(a.owner) ?? -1]
    if (!owner || owner.members.has(`.${a.key}`)) continue
    owner.memberTargets.set(`.${a.key}`, a.target)
  }
  for (const [node, id] of nodes) {
    if (out()) break
    mod.units[id]!.fp = fingerprint(sf, node, nodes, mod)
  }
  return mod
}

// A hash of the unit's tokens, blind to what does not change behaviour: whitespace, comments,
// semicolons, trailing commas, quote style, `let`/`const`/`var`, and the names of its own
// parameters and locals. Nested units stand as their names, so a change inside one is reported
// there and not again in every unit around it.
export function fingerprint(
  sf: ts.SourceFile,
  root: ts.Node,
  units: Map<ts.Node, number>,
  mod: ParsedModule
): string {
  const locals = new Set<string>()
  const collect = (n: ts.Node) => {
    mod.work++
    if (n !== root && units.has(n)) return
    if (
      (ts.isParameter(n) ||
        ts.isVariableDeclaration(n) ||
        ts.isBindingElement(n) ||
        ts.isFunctionExpression(n) ||
        ts.isClassExpression(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    )
      locals.add(n.name.text)
    if (ts.isCatchClause(n) && n.variableDeclaration)
      collect(n.variableDeclaration)
    ts.forEachChild(n, collect)
  }
  collect(root)
  const renamed = new Map<string, string>()
  const tokens: string[] = []
  const emit = (n: ts.Node) => {
    mod.work++
    if (n.kind >= FIRST_JSDOC && n.kind <= LAST_JSDOC) return
    if (n !== root && units.has(n)) {
      const u = mod.units[units.get(n)!]!
      tokens.push(mod.minified ? `<${u.kind}>` : `<${u.name}>`)
      return
    }
    const children = n.getChildren(sf)
    if (children.length > 0) {
      for (const c of children) emit(c)
      return
    }
    switch (n.kind) {
      case ts.SyntaxKind.SemicolonToken:
      case ts.SyntaxKind.EndOfFileToken:
        return
      case ts.SyntaxKind.LetKeyword:
      case ts.SyntaxKind.ConstKeyword:
        tokens.push("var")
        return
      case ts.SyntaxKind.StringLiteral:
        tokens.push(JSON.stringify((n as ts.StringLiteral).text))
        return
      case ts.SyntaxKind.NumericLiteral: {
        const v = Number((n as ts.NumericLiteral).text)
        tokens.push(Number.isFinite(v) ? String(v) : n.getText(sf))
        return
      }
      case ts.SyntaxKind.Identifier: {
        const id = n as ts.Identifier
        const name = id.text
        const isKey =
          (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) ||
          ((ts.isPropertyAssignment(id.parent) ||
            ts.isMethodDeclaration(id.parent)) &&
            id.parent.name === id)
        if (!isKey && locals.has(name)) {
          let r = renamed.get(name)
          if (!r) {
            r = `$${renamed.size}`
            renamed.set(name, r)
          }
          tokens.push(r)
        } else if (
          !isKey &&
          mod.minified &&
          (mod.top.has(name) || mod.imports.has(name))
        )
          tokens.push("$top")
        else tokens.push(name)
        return
      }
      default:
        tokens.push(n.getText(sf))
    }
  }
  emit(root)
  const kept = tokens.filter(
    (t, i) => !(t === "," && [")", "]", "}"].includes(tokens[i + 1] ?? ""))
  )
  return sha1(kept.join(" ")).slice(0, 16)
}
