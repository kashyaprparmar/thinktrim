import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.venv/**", "uv.lock"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["services/laya-sidecar/node/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        clearTimeout: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
);
