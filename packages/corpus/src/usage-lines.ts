import ts from "typescript"

// The lines of a file that use a package in ways the usage scan does not place on a line: the keys
// of objects handed to the package's calls, at any depth (`defineConfig({ dts: { oxc: true } })`),
// and the types the file imports from it (`const x: Options = { ... }`). `check` reads them as
// evidence that a fix touched what the package sees. Numbers are 1-based, as in the manifests.
export interface PackageLines {
  // lines naming a binding imported from the package
  refs: Set<number>
  // lines of object keys, JSX attributes included, that reach the package
  options: Set<number>
  // lines where a type imported from the package is written
  types: Set<number>
}

const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi

// The script parts of a Vue, Svelte or Astro file, padded with newlines so the lines keep their
// numbers.
export function scriptOf(file: string, source: string): string {
  if (/\.(?:[cm]?[jt]sx?)$/.test(file)) return source
  const lines = source.split("\n").map(() => "")
  const put = (start: number, text: string) => {
    const before = source.slice(0, start).split("\n").length - 1
    text.split("\n").forEach((l, i) => {
      if (i === 0)
        lines[before] =
          " ".repeat(start - source.lastIndexOf("\n", start - 1) - 1) + l
      else lines[before + i] = l
    })
  }
  if (file.endsWith(".astro")) {
    const m = /^---\n([\s\S]*?)\n---/.exec(source)
    if (m) put(4, m[1]!)
  }
  for (const m of source.matchAll(SCRIPT))
    put(m.index + m[0].indexOf(">") + 1, m[1]!)
  return lines.join("\n")
}

function fromPackage(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`)
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((e) =>
    ts.isOmittedExpression(e) ? [] : bindingNames(e.name)
  )
}

function requiredSpecifier(e: ts.Expression | undefined): string | undefined {
  let cur = e
  while (
    cur &&
    (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur))
  )
    cur = cur.expression
  if (
    cur &&
    ts.isCallExpression(cur) &&
    (cur.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(cur.expression) && cur.expression.text === "require")) &&
    cur.arguments[0] &&
    ts.isStringLiteralLike(cur.arguments[0])
  )
    return cur.arguments[0].text
  return undefined
}

// A name in a position that is not a reference to a binding: `a.name`, `{ name: 1 }`, a declaration.
function isReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isQualifiedName(p) && p.right === id) return false
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p)) &&
    p.name === id
  )
    return false
  if (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p)
  )
    return false
  if (ts.isImportEqualsDeclaration(p)) return false
  if (ts.isBindingElement(p) && p.propertyName === id) return false
  if (ts.isVariableDeclaration(p) && p.name === id) return false
  if (ts.isJsxAttribute(p)) return false
  return true
}

export function packageLines(
  file: string,
  source: string,
  pkg: string
): PackageLines {
  const out: PackageLines = {
    refs: new Set(),
    options: new Set(),
    types: new Set(),
  }
  const text = scriptOf(file, source)
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?[jt]s$/.test(file) && !/\.[cm]?tsx?$/.test(file)
      ? ts.ScriptKind.JS
      : /x$/.test(file) || !/\.[cm]?[jt]s$/.test(file)
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS
  )
  const lineOf = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  const locals = new Set<string>()
  const collect = (n: ts.Node): void => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      fromPackage(n.moduleSpecifier.text, pkg)
    ) {
      const c = n.importClause
      if (c?.name) locals.add(c.name.text)
      const nb = c?.namedBindings
      if (nb && ts.isNamespaceImport(nb)) locals.add(nb.name.text)
      if (nb && ts.isNamedImports(nb))
        for (const e of nb.elements) locals.add(e.name.text)
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression) &&
      fromPackage(n.moduleReference.expression.text, pkg)
    ) {
      locals.add(n.name.text)
    } else if (ts.isVariableDeclaration(n)) {
      const spec = requiredSpecifier(n.initializer)
      if (spec && fromPackage(spec, pkg))
        for (const name of bindingNames(n.name)) locals.add(name)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  if (locals.size === 0) return out

  const keysOf = (n: ts.Node | undefined): void => {
    if (!n) return
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n)
    )
      return keysOf(n.expression)
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        out.options.add(lineOf(p))
        if (ts.isPropertyAssignment(p)) keysOf(p.initializer)
      }
    } else if (ts.isArrayLiteralExpression(n)) {
      for (const e of n.elements) keysOf(e)
    }
  }

  // from a type node up to what it annotates: `const x: T = { ... }`, `{ ... } satisfies T`
  const annotated = (type: ts.Node): void => {
    let cur = type
    while (cur.parent && ts.isTypeNode(cur.parent)) cur = cur.parent
    const p = cur.parent
    if (!p) return
    if (ts.isVariableDeclaration(p) && p.type === cur) keysOf(p.initializer)
    else if (
      (ts.isSatisfiesExpression(p) || ts.isAsExpression(p)) &&
      p.type === cur
    )
      keysOf(p.expression)
    else if (ts.isPropertyDeclaration(p) && p.type === cur)
      keysOf(p.initializer)
    // a type argument: `defineConfig<Options>({ ... })`
    else if (ts.isCallExpression(p) || ts.isNewExpression(p))
      for (const a of p.arguments ?? []) keysOf(a)
  }

  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && locals.has(n.text) && isReference(n)) {
      out.refs.add(lineOf(n))
      let cur: ts.Node = n
      let inType = false
      for (;;) {
        const p: ts.Node = cur.parent
        if (!p) break
        if (
          (ts.isPropertyAccessExpression(p) ||
            ts.isElementAccessExpression(p) ||
            ts.isNonNullExpression(p) ||
            ts.isParenthesizedExpression(p) ||
            ts.isAwaitExpression(p)) &&
          p.expression === cur
        ) {
          cur = p
        } else if (ts.isQualifiedName(p) && p.left === cur) {
          cur = p
        } else if (
          (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
          p.expression === cur
        ) {
          for (const a of p.arguments ?? []) keysOf(a)
          cur = p
        } else if (ts.isTaggedTemplateExpression(p) && p.tag === cur) {
          cur = p
        } else if (
          ts.isTypeReferenceNode(p) ||
          ts.isExpressionWithTypeArguments(p) ||
          ts.isTypeQueryNode(p)
        ) {
          inType =
            ts.isTypeReferenceNode(p) ||
            ts.isTypeQueryNode(p) ||
            ts.isHeritageClause(p.parent)
          if (inType) {
            out.types.add(lineOf(p))
            annotated(p)
          }
          break
        } else if (
          (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) &&
          p.tagName === cur
        ) {
          for (const a of p.attributes.properties) out.options.add(lineOf(a))
          break
        } else break
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
