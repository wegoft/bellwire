import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/**",
      "dist-auth/**",
      "coverage/**",
      "website/dist/**",
      "website/node_modules/**",
      "website/*.tsbuildinfo",
    ],
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["website/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["website/vite.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
