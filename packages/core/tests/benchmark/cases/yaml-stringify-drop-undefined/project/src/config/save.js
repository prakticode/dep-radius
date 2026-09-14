import { writeFile } from "node:fs/promises"
import YAML from "yaml"

export async function saveConfig(path, config) {
  await writeFile(path, YAML.stringify(config))
}
