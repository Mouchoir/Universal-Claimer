import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./vitest.globalSetup.ts"],
    // DB integration tests share one Postgres; run files serially so they don't clobber each
    // other's rows. The suite is small, so the cost is negligible.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/*/src/**"],
    },
  },
});
