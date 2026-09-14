import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"

import { createCtx } from "../../src/context.ts"
import { integrityOf, packTarball } from "./pack.ts"
import type { Ctx, Options } from "../../src/options.ts"
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "../../src/infra/http.ts"

export interface FakeVersion {
  version: string
  publishedAt: string
  files: Record<string, string>
  deprecated?: string
}

export interface FakePackage {
  name: string
  repository?: string
  distTags?: Record<string, string>
  versions: FakeVersion[]
  // tag -> body
  releases?: Record<string, string>
}

// Serves packuments, tarballs and GitHub releases from memory. Every request is recorded, so a
// test can assert the run never left the fixtures.
export class FakeRegistry implements HttpClient {
  readonly requests: string[] = []
  private readonly routes = new Map<string, HttpResponse>()

  constructor(packages: FakePackage[]) {
    for (const p of packages) this.add(p)
  }

  add(p: FakePackage): void {
    const versions: Record<string, unknown> = {}
    const time: Record<string, string> = {}
    for (const v of p.versions) {
      const pj = JSON.parse(v.files["package.json"] ?? "{}") as Record<
        string,
        unknown
      >
      const tgz = packTarball(v.files)
      const url = `https://registry.npmjs.org/${p.name}/-/${p.name.split("/").pop()}-${v.version}.tgz`
      this.routes.set(url, { status: 200, headers: {}, body: tgz })
      versions[v.version] = {
        ...pj,
        name: p.name,
        version: v.version,
        ...(v.deprecated ? { deprecated: v.deprecated } : {}),
        ...(p.repository
          ? { repository: { type: "git", url: p.repository } }
          : {}),
        dist: { tarball: url, integrity: integrityOf(tgz) },
      }
      time[v.version] = v.publishedAt
    }
    const latest =
      p.distTags?.latest ?? p.versions[p.versions.length - 1]!.version
    const doc = {
      name: p.name,
      "dist-tags": { latest, ...p.distTags },
      time,
      versions,
      ...(p.repository
        ? { repository: { type: "git", url: p.repository } }
        : {}),
    }
    this.routes.set(
      `https://registry.npmjs.org/${p.name.replace("/", "%2f")}`,
      json(doc)
    )

    const gh = p.repository
      ? /github\.com\/([^/]+)\/([\w.-]+?)(?:\.git)?$/.exec(p.repository)
      : null
    if (gh) {
      const releases = Object.entries(p.releases ?? {}).map(([tag, body]) => ({
        tag_name: tag,
        body,
        draft: false,
      }))
      this.routes.set(
        `https://api.github.com/repos/${gh[1]}/${gh[2]}/releases?per_page=100`,
        json(releases)
      )
    }
  }

  async get(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req.url)
    return (
      this.routes.get(req.url) ?? {
        status: 404,
        headers: {},
        body: Buffer.from("not found"),
      }
    )
  }
}

function json(v: unknown): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(v)),
  }
}

export function testOptions(
  root: string,
  overrides: Partial<Options> = {}
): Options {
  return {
    root,
    specs: [],
    format: "json",
    offline: false,
    minAgeMs: undefined,
    latest: false,
    notes: true,
    surface: true,
    prod: false,
    concurrency: 4,
    cacheDir: mkdtempSync(join(tmpdir(), "radius-cache-")),
    verbose: false,
    now: Date.parse("2026-09-13T09:00:00Z"),
    color: false,
    ...overrides,
  }
}

export function testCtx(opts: Options, http: HttpClient): Ctx {
  const ctx = createCtx(opts, http)
  return { ...ctx, githubToken: async () => undefined }
}
