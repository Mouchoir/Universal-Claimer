import { defineConfig } from "vitest/config";

// Contract tests for connectors run against recorded/mocked fixtures — no live third-party
// calls and no real browser. See tests/fixtures per connector.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
