import { saveConfig } from "../config/save.js"

export async function init(options) {
  await saveConfig(".apprc.yml", {
    name: options.name,
    registry: options.registry,
    token: options.token,
  })
}
