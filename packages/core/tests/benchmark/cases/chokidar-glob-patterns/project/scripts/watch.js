const chokidar = require("chokidar")
const { buildStyles } = require("./styles")

const watcher = chokidar.watch("src/**/*.scss", { ignoreInitial: true })

watcher.on("all", async (event, file) => {
  console.log(`${event} ${file}`)
  await buildStyles()
})
