import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web tsconfig uses `jsx: preserve` because Next compiles the JSX itself; vitest does not
  // go through Next, so it needs the automatic runtime spelled out here.
  esbuild: { jsx: "automatic" },
  test: {
    // .tsx too: React components carry behaviour worth testing (secret-inputs toggles `type`
    // on a focused field, which is exactly the sort of thing that breaks silently).
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}"],
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
