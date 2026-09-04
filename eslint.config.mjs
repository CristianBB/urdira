import babelParser from "@babel/eslint-parser";
import eslint from "@eslint/js";

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
};

export default [
  {
    // `**/target/**` (Rust's build/output directory) excludes not just
    // compiled Rust artifacts but transient e2e-test scratch checkouts that
    // land there too (e.g. `crates/*/target/v4-e2e-test/*/workspace/`, a
    // full copy of a THIRD-PARTY corpus's own scripts, benchmarked and
    // deleted by the Rust test harness itself) -- none of it is this
    // repo's own source, and lint shape/`no-undef` findings inside it are
    // not this repo's to fix.
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "**/coverage/**", "pnpm-lock.yaml", "**/target/**"],
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.mjs"],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: ["@babel/plugin-syntax-typescript"],
        },
      },
      globals: {
        ...nodeGlobals,
        describe: "readonly",
        expect: "readonly",
        it: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.tsx"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [["@babel/plugin-syntax-typescript", { isTSX: true }]],
        },
      },
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "off",
    },
  },
];
