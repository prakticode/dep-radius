const { program } = require("commander")
const { deploy } = require("../src/deploy")

program
  .option("-e, --env <name>", "target environment", "staging")
  .action((options) => {
    deploy(options.env, program.args)
  })

program.parse()
