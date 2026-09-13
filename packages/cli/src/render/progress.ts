import { progress, type ProgressResult, spinner } from "@clack/prompts"

import type { Brief, RunEvent } from "@dep-radius/core"

export interface ProgressView {
  onEvent(e: RunEvent): void
  finish(brief: Brief): void
  fail(): void
}

// Drawn on stderr, and only when a person is watching: the report on stdout stays byte for byte
// what a script or an agent reads.
export function createProgressView(
  output: NodeJS.WriteStream,
  now: () => number = Date.now
): ProgressView {
  const started = now()
  const reading = spinner({ output, withGuide: false })
  reading.start("Reading project files")
  let bar: ProgressResult | undefined
  let files = 0
  const running = new Set<string>()

  return {
    onEvent(e) {
      if (e.type === "files") {
        files = e.total
        reading.message(`Reading project files  ${e.done}/${e.total}`)
      } else if (e.type === "packages") {
        reading.stop(`Read ${files} ${files === 1 ? "file" : "files"}`)
        if (e.total === 0) return
        bar = progress({ output, withGuide: false, max: e.total, size: 30 })
        bar.start(
          `Checking ${e.total} ${e.total === 1 ? "package" : "packages"}`
        )
      } else if (e.type === "package-start") {
        running.add(e.name)
      } else if (bar) {
        running.delete(e.name)
        const percent = Math.round((100 * e.done) / e.total)
        // every package starts at once, so names only help once a few slow ones remain
        const waiting =
          running.size > 0 && running.size <= 3
            ? `  waiting on ${[...running].join(", ")}`
            : ""
        bar.advance(1, `${e.done}/${e.total}  ${percent}%${waiting}`)
      }
    },
    finish(brief) {
      const seconds = ((now() - started) / 1000).toFixed(1)
      const checked = brief.packages.length + brief.upToDate
      const message = `Checked ${checked} ${checked === 1 ? "package" : "packages"} in ${seconds}s`
      if (bar) bar.stop(message)
      else reading.stop(message)
    },
    fail() {
      if (bar) bar.error("Stopped")
      else reading.error("Stopped")
    },
  }
}
