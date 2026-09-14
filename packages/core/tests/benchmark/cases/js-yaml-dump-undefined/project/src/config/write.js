const fs = require("node:fs")
const yaml = require("js-yaml")

function writeConfig(path, config) {
  fs.writeFileSync(path, yaml.dump(config))
}

module.exports = { writeConfig }
