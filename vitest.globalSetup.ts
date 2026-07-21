// Import the built package directly: this file sits at the repo root where pnpm does not
// symlink workspace packages, so we point at the compiled output (built before `pnpm test`).
import { runMigrations } from "./packages/db/dist/index.js";

/**
 * Global setup for the test run: when DATABASE_URL_TEST is set, apply migrations + seed ONCE
 * before any test file, so the parallel integration tests don't race on running migrations
 * concurrently. Without the env var (normal unit runs), this is a no-op and integration tests
 * skip themselves.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST;
  if (url) await runMigrations(url);
}
