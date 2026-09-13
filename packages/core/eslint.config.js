import { config } from "@repo/eslint-config"

export default config({
  tsconfigRootDir: import.meta.dirname,
  envAllowedIn: ["src/context.ts", "src/debug.ts", "scripts/**"],
})
