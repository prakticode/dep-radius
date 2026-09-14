import ts from "typescript"

import { sha1 } from "../infra/hash.ts"

// Bump when a normalization changes: the cache key carries it, so old surfaces are never compared
// with new ones.
export const ALGO = 11

const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature |
  ts.TypeFormatFlags.OmitParameterModifiers |
  ts.TypeFormatFlags.WriteTypeArgumentsOfSignature

const MAX_LEN = 3000

export function typeText(
  checker: ts.TypeChecker,
  type: ts.Type,
  typeParams: string[] = []
): string {
  let s = checker.typeToString(type, undefined, FLAGS)
  s = renameTypeParams(s, typeParams)
  return normalizeTypeText(s)
}

// Parameter names are dropped (renaming one breaks nobody) and type parameters are renamed by
// position, so `<T>(value: T) => T` and `<U>(v: U) => U` print the same.
export function signatureText(
  checker: ts.TypeChecker,
  sig: ts.Signature
): string {
  const tps = sig.getTypeParameters() ?? []
  const names = tps.map((tp) => tp.symbol?.name ?? "T")
  const tpText = tps.map((tp, i) => {
    const c = tp.getConstraint()
    return c ? `$T${i} extends ${typeText(checker, c, names)}` : `$T${i}`
  })
  const params = sig.getParameters().map((p) => {
    const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined
    const type = decl
      ? checker.getTypeOfSymbolAtLocation(p, decl)
      : checker.getTypeOfSymbol(p)
    const rest = !!decl?.dotDotDotToken
    const optional = !!decl && (!!decl.questionToken || !!decl.initializer)
    return `${rest ? "..." : ""}${typeText(checker, type, names)}${optional ? "?" : ""}`
  })
  const ret = typeText(checker, checker.getReturnTypeOfSignature(sig), names)
  const out = `${tpText.length > 0 ? `<${tpText.join(", ")}>` : ""}(${params.join(", ")}) => ${ret}`
  return out.length > MAX_LEN ? `#${sha1(out)}` : out
}

function renameTypeParams(s: string, names: string[]): string {
  let out = s
  names.forEach((n, i) => {
    if (!n || n.startsWith("$T")) return
    out = out.replace(
      new RegExp(`(?<![\\w$.])${n.replace(/[$]/g, "\\$")}(?![\\w$])`, "g"),
      `$T${i}`
    )
  })
  return out
}

export function normalizeTypeText(input: string): string {
  let s = stripQualifiers(input.replace(/import\("[^"]*"\)\./g, ""))
    .replace(/\s+/g, " ")
    .replace(/;\s*}/g, " }")
    .trim()
  s = sortOperands(s)
  return s.length > MAX_LEN ? `#${sha1(s)}` : s
}

// `ui.Component` and `Component` are the same type printed
// through two import styles; the qualifier follows how a declaration file imports, not the API.
function stripQualifiers(s: string): string {
  let out = ""
  let inStr: string | undefined
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      out += ch
      if (ch === inStr && s[i - 1] !== "\\") inStr = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch
      out += ch
      continue
    }
    const m = /^[A-Za-z_$][\w$]*\.(?=[A-Za-z_$])/.exec(s.slice(i))
    const prev = s[i - 1]
    if (m && (prev === undefined || !/[\w$.]/.test(prev))) {
      // drop every qualifier in a row: a.b.C -> C
      let j = i + m[0].length
      for (
        let n = /^[A-Za-z_$][\w$]*\.(?=[A-Za-z_$])/.exec(s.slice(j));
        n;
        n = /^[A-Za-z_$][\w$]*\.(?=[A-Za-z_$])/.exec(s.slice(j))
      )
        j += n[0].length
      i = j - 1
      continue
    }
    out += ch
  }
  return out
}

// Union and intersection members print in type-id order, which moves when unrelated code changes.
// Sort them at every bracket depth.
function sortOperands(s: string): string {
  // `error?: string | undefined` inside an object type: the label is not a union member
  const label =
    /^((?:readonly\s+)?(?:[\w$]+|"[^"]*"|'[^']*'|\[[^\]]*\])\??:\s*)/.exec(s)
  if (label?.[1]) return label[1] + sortOperands(s.slice(label[1].length))
  const parts = splitTop(s, ["|", "&"])
  if (parts.items.length > 1) {
    const op = parts.op!
    return parts.items
      .map((p) => sortOperands(p.trim()))
      .sort()
      .join(` ${op} `)
  }
  let out = ""
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === "(" || ch === "<" || ch === "[" || ch === "{") {
      const close = matching(s, i)
      if (close < 0) return s
      const inner = s.slice(i + 1, close)
      out +=
        ch +
        splitSeparators(inner)
          .map((seg) => {
            const lead = seg.match(/^\s*/)?.[0] ?? ""
            const trail =
              seg.slice(lead.length).match(/\s*[,;]?\s*$/)?.[0] ?? ""
            return (
              lead +
              sortOperands(seg.slice(lead.length, seg.length - trail.length)) +
              trail
            )
          })
          .join("") +
        s[close]
      i = close + 1
    } else {
      out += ch
      i++
    }
  }
  return out
}

// "a, B<c, d>; e" -> ["a, ", "B<c, d>; ", "e"]: separators at depth zero only, kept on their segment
function splitSeparators(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr: string | undefined
  let cur = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    cur += ch
    if (inStr) {
      if (ch === inStr && s[i - 1] !== "\\") inStr = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") inStr = ch
    else if ("(<[{".includes(ch)) depth++
    else if (")]}".includes(ch) || (ch === ">" && s[i - 1] !== "=")) depth--
    else if (depth === 0 && (ch === "," || ch === ";")) {
      out.push(cur)
      cur = ""
    }
  }
  if (cur) out.push(cur)
  return out
}

function splitTop(s: string, ops: string[]): { items: string[]; op?: string } {
  let depth = 0
  let inStr: string | undefined
  const items: string[] = []
  let cur = ""
  let op: string | undefined
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      cur += ch
      if (ch === inStr && s[i - 1] !== "\\") inStr = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch
      cur += ch
      continue
    }
    if ("(<[{".includes(ch)) depth++
    else if (")>]}".includes(ch) && !(ch === ">" && s[i - 1] === "=")) depth--
    if (depth === 0 && ops.includes(ch) && s[i + 1] !== ch && s[i - 1] !== ch) {
      if (op && op !== ch) return { items: [s] }
      op = ch
      items.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  items.push(cur)
  return items.length > 1 ? { items, op: op! } : { items: [s] }
}

function matching(s: string, open: number): number {
  const pairs: Record<string, string> = {
    "(": ")",
    "<": ">",
    "[": "]",
    "{": "}",
  }
  const stack: string[] = []
  let inStr: string | undefined
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (ch === inStr && s[i - 1] !== "\\") inStr = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch
      continue
    }
    if (pairs[ch]) stack.push(pairs[ch])
    else if (ch === ">" && s[i - 1] === "=") continue
    else if (ch === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}
