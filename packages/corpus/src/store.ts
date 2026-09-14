import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"

// Mined data is large and belongs to whoever runs the miner, never to the repository.
export function defaultDataDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_CACHE_HOME
    ? join(env.XDG_CACHE_HOME, "dep-radius-corpus")
    : join(homedir(), ".cache", "dep-radius-corpus")
}

// Written through a rename: a run stopped halfway must never leave a truncated file that a resumed
// run trusts.
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}
