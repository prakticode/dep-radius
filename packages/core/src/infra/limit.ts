export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>

export function createLimiter(concurrency: number): Limiter {
  let active = 0
  const queue: (() => void)[] = []
  const next = () => {
    if (active >= concurrency) return
    const run = queue.shift()
    if (run) run()
  }
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
}

export function once<K, V>(fn: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const memo = new Map<K, Promise<V>>()
  return (key) => {
    let p = memo.get(key)
    if (!p) {
      p = fn(key)
      memo.set(key, p)
    }
    return p
  }
}
