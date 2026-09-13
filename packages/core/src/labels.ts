// Plain words for the kinds of things radius cannot see, shared by the verdict and the renderers.
export const UNSEEN_LABEL: Record<string, string> = {
  "side-effect-import": "imported for side effects",
  "config-reference": "named in a config file",
  "script-bin": "run from scripts",
  "css-import": "imported from CSS",
  "convention-framework": "a framework used through file conventions",
  "ambient-types": "ambient types",
  "namespace-escape": "passed around as a whole",
  "computed-member": "read with computed keys",
  "dynamic-import-escape": "loaded with import() and passed on",
  "prefix-dynamic-import": "loaded by a computed subpath",
  "public-reexport": "re-exported to your own consumers",
  "unresolved-local-import": "reached through imports that did not resolve",
  "derived-escape": "values passed through too many files",
  "unparseable-file": "used in files that did not parse",
  "unresolved-against-surface": "names not found in its types",
}
