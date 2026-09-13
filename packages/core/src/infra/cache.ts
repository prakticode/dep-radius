import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"

export function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  if (env.RADIUS_CACHE_DIR) return env.RADIUS_CACHE_DIR
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "dep-radius")
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Caches", "dep-radius")
  if (process.platform === "win32" && env.LOCALAPPDATA)
    return join(env.LOCALAPPDATA, "dep-radius", "Cache")
  return join(homedir(), ".cache", "dep-radius")
}

export interface CacheEntry<T> {
  value: T
  storedAt: number
}

export class DiskCache {
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }

  path(key: string): string {
    return join(this.dir, key)
  }

  async getJson<T>(key: string): Promise<CacheEntry<T> | undefined> {
    try {
      const raw = await readFile(this.path(key), "utf8")
      return JSON.parse(raw) as CacheEntry<T>
    } catch {
      return undefined
    }
  }

  async setJson<T>(key: string, value: T, now: number): Promise<void> {
    await this.writeAtomic(
      key,
      JSON.stringify({ value, storedAt: now } satisfies CacheEntry<T>)
    )
  }

  async getBytes(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(key))
    } catch {
      return undefined
    }
  }

  async setBytes(key: string, bytes: Uint8Array): Promise<void> {
    await this.writeAtomic(key, bytes)
  }

  async has(key: string): Promise<boolean> {
    try {
      await stat(this.path(key))
      return true
    } catch {
      return false
    }
  }

  // A crash mid-write must never leave a truncated entry that a later offline run trusts.
  private async writeAtomic(
    key: string,
    data: string | Uint8Array
  ): Promise<void> {
    const target = this.path(key)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, target)
  }
}

export function safeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@-]+/g, "_")
}
