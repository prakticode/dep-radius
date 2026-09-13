import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import perfectionist from "eslint-plugin-perfectionist"
import eslintConfigPrettier from "eslint-config-prettier"

// Recommended JavaScript and type-checked TypeScript rules, plus the conventions below: how comments,
// test titles and JSON imports are written, and how imports are ordered. Every package of the
// workspace calls config() from its own eslint.config.js.

const testTitleMessage =
  'A test title is English and states a fact, without "should": it reads as documentation.'
const testTitlePattern = "^should\\b|[\\u00C0-\\u017F]"
const testCallee =
  "CallExpression:matches([callee.name=/^(it|test|describe)$/], [callee.object.name=/^(it|test|describe)$/], [callee.object.object.name=/^(it|test|describe)$/], [callee.callee.object.name=/^(it|test|describe)$/])"
const testTitleSelectors = [
  {
    selector: `${testCallee} > Literal.arguments:first-child[value=/${testTitlePattern}/]`,
    message: testTitleMessage,
  },
  {
    selector: `${testCallee} > TemplateLiteral.arguments:first-child[quasis.0.value.raw=/${testTitlePattern}/]`,
    message: testTitleMessage,
  },
]

// A bare JSON import compiles under a bundler and throws under plain Node ESM, and plain Node ESM
// is what runs radius.
const jsonImportSelector = {
  selector: "ImportDeclaration[source.value=/\\.json$/][attributes.length=0]",
  message:
    'A JSON import carries with { type: "json" }: Node ESM refuses it without.',
}

// How comments are written and imports ordered, in every package and app. An app with its own
// framework config (the docs, on Next.js) spreads these after it.
export const conventions = [
  {
    rules: {
      "no-warning-comments": [
        "error",
        {
          terms: [
            "this ",
            "we ",
            "helper",
            "returns ",
            "gets ",
            "sets ",
            "adds ",
            "handles ",
            "todo",
            "fixme",
          ],
          location: "start",
          decoration: ["*"],
        },
      ],
    },
  },
  {
    plugins: { perfectionist },
    rules: {
      // Sorted by ESLint and not by Prettier because no Prettier sorter offers
      // a length comparator; the fallback keeps two lines of equal length in a
      // deterministic order.
      "perfectionist/sort-imports": [
        "error",
        {
          type: "line-length",
          order: "asc",
          fallbackSort: { type: "natural" },
          newlinesBetween: 1,
          groups: [
            "builtin",
            "external",
            "workspace",
            "internal",
            ["parent", "sibling", "index"],
          ],
          customGroups: [
            { groupName: "workspace", elementNamePattern: "^@dep-radius/" },
          ],
        },
      ],
      "perfectionist/sort-named-imports": ["error", { type: "natural" }],
    },
  },
]

/**
 * @param {{ tsconfigRootDir: string, envAllowedIn: string[] }} options
 *   tsconfigRootDir: the package folder, for type-checked rules
 *   envAllowedIn: the entry files of the package, the only ones allowed to read process.env
 */
export function config({ tsconfigRootDir, envAllowedIn }) {
  return tseslint.config(
    { ignores: ["dist/**", "coverage/**"] },
    js.configs.recommended,
    eslintConfigPrettier,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: {
            allowDefaultProject: ["eslint.config.js"],
          },
          tsconfigRootDir,
        },
      },
      rules: {
        // `const { a: _a, ...rest } = x` is how a field is dropped from a copy
        "@typescript-eslint/no-unused-vars": [
          "error",
          { ignoreRestSiblings: true },
        ],
        // Off: an async with no await can be what honours an interface, and the
        // rule cannot tell that apart from an oversight.
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/no-misused-promises": [
          "error",
          { checksVoidReturn: { attributes: false } },
        ],
      },
    },
    {
      files: ["**/*.{js,mjs,cjs}"],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      files: ["**/*.{js,mjs,cjs}"],
      languageOptions: { globals: globals.node },
    },
    ...conventions,
    // before the test files block: a later block replaces a rule, so the test titles would be lost
    {
      rules: { "no-restricted-syntax": ["error", jsonImportSelector] },
    },
    {
      files: ["**/*.test.ts"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "no-restricted-syntax": [
          "error",
          ...testTitleSelectors,
          jsonImportSelector,
        ],
      },
    },
    {
      // The environment is read at the edges, where the command starts, and handed down as
      // arguments, so every module below stays testable without touching process.env.
      files: ["src/**"],
      ignores: envAllowedIn,
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "process",
            property: "env",
            message: `The environment is read in ${envAllowedIn.join(", ")}, and handed down as an argument.`,
          },
        ],
      },
    }
  )
}
