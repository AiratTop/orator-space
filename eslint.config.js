import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.astro/**", "**/.wrangler/**", "spikes/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `no-undef` duplicates what the compiler already does, and it cannot see ambient
    // runtime globals, so on TypeScript sources it only produces false positives.
    files: ["**/*.ts", "**/*.mts"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.js"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", fetch: "readonly", setTimeout: "readonly" },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
);
