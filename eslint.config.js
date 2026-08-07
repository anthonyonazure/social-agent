import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  // Leading **/ matters: "dist/**" only ever matched a dist folder at the repo
  // root, so a nested build output (packages/*/dist, ticker/dist) was linted as
  // if it were source and buried the real findings under hundreds of errors
  // about generated code.
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/*.cjs", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
