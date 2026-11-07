import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", ".vercel/", "public/", "playwright-report/", "test-results/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly", Response: "readonly", Request: "readonly", Headers: "readonly", AbortSignal: "readonly", setTimeout: "readonly", crypto: "readonly", TextEncoder: "readonly", Buffer: "readonly" } },
    rules: {
      // the gateway returns loosely typed JSON; `any` is confined to parsing boundaries
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
