import { Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { Brief } from "@dep-radius/core"

import { createProgressView } from "../../src/render/progress.ts"

function screen() {
  let text = ""
  const out = new Writable({
    write(chunk: Buffer, _enc, done) {
      text += chunk.toString()
      done()
    },
  }) as Writable & { columns: number; isTTY: boolean }
  out.columns = 100
  out.isTTY = true
  return {
    out: out as unknown as NodeJS.WriteStream,
    // strip colours and cursor moves, keep what a person reads
    read: () => stripVTControlCharacters(text),
  }
}

describe("createProgressView", () => {
  afterEach(() => vi.useRealTimers())

  it("counts files, then packages with a percentage, then says how long it took", () => {
    // frames are drawn on a timer, as a terminal would see them
    vi.useFakeTimers()
    const tick = () => vi.advanceTimersByTime(100)
    const s = screen()
    let clock = 0
    const view = createProgressView(s.out, () => clock)
    view.onEvent({ type: "files", done: 25, total: 50 })
    tick()
    view.onEvent({ type: "files", done: 50, total: 50 })
    view.onEvent({ type: "packages", total: 4 })
    for (const name of ["a", "b", "c", "d"])
      view.onEvent({ type: "package-start", name })
    view.onEvent({ type: "package", name: "a", done: 1, total: 4 })
    tick()
    view.onEvent({ type: "package", name: "c", done: 2, total: 4 })
    tick()
    clock = 2500
    view.finish({ packages: [{}, {}], upToDate: 2 } as unknown as Brief)
    const text = s.read()
    expect(text).toContain("Read 50 files")
    expect(text).toContain("1/4  25%")
    expect(text).toContain("2/4  50%  waiting on b, d")
    expect(text).toContain("Checked 4 packages in 2.5s")
  })
})
