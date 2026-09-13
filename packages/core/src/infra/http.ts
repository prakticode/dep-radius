export interface HttpRequest {
  url: string
  headers?: Record<string, string>
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export interface HttpClient {
  get(req: HttpRequest): Promise<HttpResponse>
}

export class OfflineError extends Error {
  constructor(url: string) {
    super(`offline: ${url}`)
  }
}

export class FetchHttp implements HttpClient {
  private readonly retries: number
  constructor(retries = 2) {
    this.retries = retries
  }

  async get(req: HttpRequest): Promise<HttpResponse> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await fetch(req.url, {
          headers: req.headers,
          redirect: "follow",
        })
        const body = Buffer.from(await res.arrayBuffer())
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
        if (res.status >= 500 && attempt < this.retries) {
          await delay(250 * 2 ** attempt)
          continue
        }
        return { status: res.status, headers, body }
      } catch (error) {
        lastError = error
        if (attempt < this.retries) await delay(250 * 2 ** attempt)
      }
    }
    throw lastError
  }
}

export class NoNetworkHttp implements HttpClient {
  async get(req: HttpRequest): Promise<HttpResponse> {
    throw new OfflineError(req.url)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
