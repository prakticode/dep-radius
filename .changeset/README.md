# Changesets

Every pull request that changes what users get adds one file here with `pnpm changeset`: which
packages change, the bump (patch, minor, major) and one sentence for the changelog.

`@dep-radius/core` and `dep-radius` are released together with the same version, so
`radius --version` and the engine version in `--json` always match.

Releasing: `pnpm version-packages` applies the pending changesets (versions and CHANGELOG.md), then
`pnpm release` builds and publishes.
