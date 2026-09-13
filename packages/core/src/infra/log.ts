export interface Logger {
  verbose: boolean
  debug(msg: string): void
  warn(msg: string): void
}

export function createLogger(verbose: boolean): Logger {
  return {
    verbose,
    debug(msg) {
      if (verbose) process.stderr.write(`radius: ${msg}\n`)
    },
    warn(msg) {
      process.stderr.write(`radius: ${msg}\n`)
    },
  }
}

export const silentLogger: Logger = { verbose: false, debug() {}, warn() {} }
