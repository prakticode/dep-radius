// Building blocks for a renderer of your own: how briefs are grouped and labelled, shared by the
// markdown renderer here and the terminal renderer of the CLI.

export {
  ago,
  coverageLabel,
  type Finding,
  groupBriefs,
  type Groups,
  isUnseenOnly,
  likelyLabel,
  oneNetOnly,
  opaqueLabel,
  orderFindings,
  sinceLabel,
  siteLabel,
  sitesFor,
  usedLabel,
  surfaceLabel,
} from "./groups.ts"
