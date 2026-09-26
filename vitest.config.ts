import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
