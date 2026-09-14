export type * from "./model.ts"
export { diffImplementations } from "./diff.ts"
export {
  type DiffResult,
  getImplementationDiff,
  getImplementationFacts,
  getImplementationPair,
  type PairResult,
} from "./load.ts"
export {
  HINT_CHANGED_SHARE,
  type HintOutcome,
  implementationHints,
  linkHints,
} from "./hints.ts"
export { reachableEntryExports, usedExports } from "./used.ts"
export { type Flavor, flavorFor, resolveRuntimeEntries } from "./entries.ts"
export {
  buildImplementationFacts,
  DEFAULT_LIMITS,
  type Limits,
  reach,
  reachableNames,
  shortName,
} from "./graph.ts"
