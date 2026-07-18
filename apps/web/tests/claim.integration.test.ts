import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultFingerprint } from "@uc/connectors";
import {
  createAccount,
  createDb,
  createJob,
  finishJob,
  getJob,
  hasActiveJobForAccount,
  markRequiresHumanAction,
  markRunning,
  runMigrations,
  type DbHandle,
} from "@uc/db";
import { reconcileInterruptedJobs } from "../../worker/src/reconcile.js";

/**
 * DB-level integration for claim concurrency + interrupted-job reconciliation (US3 / T035).
 * Gated on DATABASE_URL_TEST.
 */
const url = process.env.DATABASE_URL_TEST;
const maybe = url ? describe : describe.skip;

maybe("claim jobs (integration)", () => {
  let handle: DbHandle;
  let accountId: string;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!);
    await handle.pool.query("DELETE FROM job");
    await handle.pool.query("DELETE FROM connected_account");
    const account = await createAccount(handle.db, {
      serviceId: "epic",
      method: "session_import",
      secretCiphertext: Buffer.from("x"),
      secretDataKey: Buffer.from("y"),
      fingerprint: defaultFingerprint(),
    });
    accountId = account.id;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("reports an active job and clears it on finish (concurrency guard)", async () => {
    expect(await hasActiveJobForAccount(handle.db, accountId)).toBe(false);
    const jobId = await createJob(handle.db, accountId);
    expect(await hasActiveJobForAccount(handle.db, accountId)).toBe(true);
    await finishJob(handle.db, jobId, "nothing_to_claim", "none");
    expect(await hasActiveJobForAccount(handle.db, accountId)).toBe(false);
  });

  it("reconciles interrupted (running) jobs on startup", async () => {
    const jobId = await createJob(handle.db, accountId);
    await markRunning(handle.db, jobId);
    const count = await reconcileInterruptedJobs(handle.db);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await hasActiveJobForAccount(handle.db, accountId)).toBe(false);
  });

  it("resumes a human-action job by moving it back to running (not restarting)", async () => {
    const jobId = await createJob(handle.db, accountId);
    await markRequiresHumanAction(handle.db, jobId);
    expect((await getJob(handle.db, jobId))?.state).toBe("requires_human_action");
    // Resume transition (what the human-action endpoint performs).
    await markRunning(handle.db, jobId);
    expect((await getJob(handle.db, jobId))?.state).toBe("running");
  });
});
