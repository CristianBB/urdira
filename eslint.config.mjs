import babelParser from "@babel/eslint-parser";
import eslint from "@eslint/js";

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
};

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "**/coverage/**", "pnpm-lock.yaml"],
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
];
