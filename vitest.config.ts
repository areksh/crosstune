import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded: DOM/socket/process I/O glue with no meaningful unit under test.
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test-support.ts",
        "src/cli.ts",
        "src/web/**",
        "src/server/http.ts",
        "src/cli/oauth-login.ts",
        "src/cli/sign-in-listener.ts",
        "src/cli/open-browser.ts",
      ],
    },
  },
});
