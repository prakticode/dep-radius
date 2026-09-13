import { conventions } from "@repo/eslint-config"
import nextVitals from "eslint-config-next/core-web-vitals"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  ...nextVitals,
  ...conventions,
  globalIgnores([".next/**", "out/**", "next-env.d.ts", ".source/**"]),
])
