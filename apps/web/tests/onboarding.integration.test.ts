import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "@uc/db";
import {
  isSetupNeeded,
  recoverPassword,
  setupAdmin,
  verifyLogin,
  SetupAlreadyDoneError,
} from "../src/server/admin-service.js";
import { DrizzleAdminStore } from "../src/server/store.js";

/**
 * Integration test for the DB-backed onboarding flow (US1 / T018). Runs only when
 * DATABASE_URL_TEST points at a disposable Postgres; otherwise it is skipped so the default
 * `pnpm test` stays hermetic.
 */
const url = process.env.DATABASE_URL_TEST;
const maybe = url ? describe : describe.skip;

maybe("onboarding (integration)", () => {
  let handle: DbHandle;
  let store: DrizzleAdminStore;

  beforeAll(async () => {
    handle = createDb(url!);
    store = new DrizzleAdminStore(handle.db);
    // Clean admin state (services are seeded by migrations and left intact).
    await handle.pool.query("DELETE FROM security_question");
    await handle.pool.query("DELETE FROM admin");
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("goes setup → login → rejects a second setup", async () => {
    expect(await isSetupNeeded(store)).toBe(true);

    await setupAdmin(store, {
      password: "correct horse battery",
      recovery: [
        { question: "First pet?", answer: "Rex" },
        { question: "Birth city?", answer: "Lyon" },
        { question: "Favorite game?", answer: "Portal" },
      ],
    });

    expect(await isSetupNeeded(store)).toBe(false);
    expect(await verifyLogin(store, "correct horse battery")).toBe(true);
    expect(await verifyLogin(store, "wrong")).toBe(false);

    await expect(setupAdmin(store, { password: "second admin" })).rejects.toBeInstanceOf(
      SetupAlreadyDoneError,
    );

    await recoverPassword(store, ["rex", "LYON", " portal "], "new strong password");
    expect(await verifyLogin(store, "new strong password")).toBe(true);
  });
});
