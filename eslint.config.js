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
    // Node scripts run outside the TypeScript project, so the compiler is not there to
    // vouch for these; they are the Web-standard globals Node has provided for years.
    files: ["scripts/**/*.mjs", "*.config.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        Buffer: "readonly",
        URL: "readonly",
      },
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
