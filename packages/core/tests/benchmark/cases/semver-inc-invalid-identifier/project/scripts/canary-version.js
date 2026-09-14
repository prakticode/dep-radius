const semver = require("semver")

const [current, branch] = process.argv.slice(2)
const version = semver.inc(current, "prerelease", branch)

process.stdout.write(`${version}\n`)
