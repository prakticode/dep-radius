const semver = require("semver")

function shouldAutoUpdate(installed, latest) {
  if (!semver.gt(latest, installed)) return false
  return semver.diff(installed, latest) !== "major"
}

module.exports = { shouldAutoUpdate }
