import { existsSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const root = process.cwd()

// ESLint reads the config of the package a file belongs to, so each package lints its own files.
function packageOf(file) {
  let dir = dirname(file)
  while (dir !== root && !existsSync(resolve(dir, "eslint.config.js")))
    dir = dirname(dir)
  return dir
}

function lintPerPackage(files) {
  const groups = new Map()
  for (const file of files) {
    const dir = packageOf(file)
    if (dir === root) continue
    groups.set(dir, [...(groups.get(dir) ?? []), relative(dir, file)])
  }
  return [...groups].map(
    ([dir, names]) =>
      `pnpm --dir ${dir} exec eslint --fix --max-warnings 0 ${names.join(" ")}`
  )
}

// Prettier formats first, then ESLint sorts imports: the import order is measured on formatted lines.
// Typecheck and tests run through Turborepo, from .husky/pre-commit.
export default {
  "*.{ts,tsx,js,mjs,cjs}": ["prettier --write", lintPerPackage],
  "*.{json,md,yaml,yml,css}": "prettier --write",
}
