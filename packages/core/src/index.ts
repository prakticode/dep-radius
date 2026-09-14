// The public API of the engine. Everything a consumer needs to analyse a project and render the
// result; the modules behind it are free to move.

export { createCtx } from "./context.ts"
export { defaultCacheDir } from "./infra/cache.ts"
export type { HttpClient, HttpRequest, HttpResponse } from "./infra/http.ts"
export type * from "./model.ts"
export {
  type Ctx,
  DEFAULT_MIN_AGE_MS,
  type Format,
  formatAge,
  type Options,
  parseDuration,
  type RunEvent,
} from "./options.ts"
export {
  type BriefV1,
  type CannotSeeV1,
  type PackageV1,
  renderJson,
  type SiteV1,
  toJsonV1,
  type UnplacedV1,
} from "./render/json.ts"
export { renderMarkdown } from "./render/markdown.ts"
export { parseSpec, run, type Spec, toolVersion } from "./run.ts"
