import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "@uc/core";
import { createDb } from "@uc/db";
import { resetPassword } from "../server/admin-service.js";
import { DrizzleAdminStore } from "../server/store.js";

/**
 * Host-side admin password reset (FR-002b). Works regardless of whether recovery questions
 * were configured — whoever controls the host controls the deployment.
 *
 * Run:  corepack pnpm --filter @uc/web reset-admin
 * Non-interactive:  UC_NEW_PASSWORD=... corepack pnpm --filter @uc/web reset-admin
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const handle = createDb(cfg.DATABASE_URL);
  const store = new DrizzleAdminStore(handle.db);

  let password = process.env.UC_NEW_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: stdin, output: stdout });
    password = (await rl.question("New admin password (min 8 chars): ")).trim();
    rl.close();
  }

  await resetPassword(store, password);
  await handle.close();
  console.log("Admin password has been reset.");
}

main().catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
