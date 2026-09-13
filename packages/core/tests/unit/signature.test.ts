import { describe, expect, it } from "vitest"

import { normalizeTypeText } from "../../src/surface/signature.ts"

describe("normalizeTypeText", () => {
  it("sorts union members, not the property labels in front of them", () => {
    expect(
      normalizeTypeText(
        "{ error?: string | undefined | $ErrorMap<X>; abort?: undefined | boolean; }"
      )
    ).toBe(
      "{ error?: $ErrorMap<X> | string | undefined; abort?: boolean | undefined }"
    )
  })

  it("sorts inside nested generics without cutting them apart", () => {
    expect(normalizeTypeText("Record<string, Array<b | a>>")).toBe(
      "Record<string, Array<a | b>>"
    )
    expect(normalizeTypeText("F<C | E, D | B>")).toBe("F<C | E, B | D>")
  })

  it("leaves arrows alone", () => {
    expect(normalizeTypeText("(payload: P) => boolean | undefined")).toBe(
      "(payload: P) => boolean | undefined"
    )
  })

  it("gives the same text for the same union in another order", () => {
    expect(normalizeTypeText('"b" | "a" | "c"')).toBe(
      normalizeTypeText('"c" | "a" | "b"')
    )
  })

  it("drops import() and namespace qualifiers, never inside strings", () => {
    expect(normalizeTypeText('import("/pkg/index").StringSchema')).toBe(
      "StringSchema"
    )
    expect(normalizeTypeText("react.ForwardRefExoticComponent<any>")).toBe(
      normalizeTypeText("ForwardRefExoticComponent<any>")
    )
    expect(normalizeTypeText("Record<string, core.util.JSON>")).toBe(
      "Record<string, JSON>"
    )
    expect(normalizeTypeText('"a.b" | 1.5')).toBe('"a.b" | 1.5')
  })
})
