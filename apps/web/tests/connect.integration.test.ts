import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSecretString, sealSecret } from "@uc/core";
import { defaultFingerprint } from "@uc/connectors";
import {
  createAccount,
  createDb,
  getAccountByService,
  hasConsent,
  recordConsent,
  runMigrations,
  type DbHandle,
} from "@uc/db";

/**
 * Integration test for the connect + consent data flow (US2 / T027). Runs only when
 * DATABASE_URL_TEST is set. Verifies consent recording, one-account-per-service, and that
 * the stored secret is ciphertext (no plaintext at rest, SC-004).
 */
const url = process.env.DATABASE_URL_TEST;
const maybe = url ? describe : describe.skip;

const MASTER_KEY = Buffer.alloc(32, 7);

maybe("connect + consent (integration)", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!);
    await handle.pool.query("DELETE FROM connected_account");
    await handle.pool.query("DELETE FROM consent_record");
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("records consent, stores an encrypted secret, and enforces one account per service", async () => {
    const { db } = handle;
    expect(await hasConsent(db, "epic")).toBe(false);
    await recordConsent(db, "epic", "warning text");
    expect(await hasConsent(db, "epic")).toBe(true);

    const secretPlain = JSON.stringify({ cookies: [{ name: "EPIC_SSO", value: "TOP-SECRET" }] });
    const sealed = sealSecret(secretPlain, MASTER_KEY);
    const account = await createAccount(db, {
      serviceId: "epic",
      method: "session_import",
      secretCiphertext: sealed.ciphertext,
      secretDataKey: sealed.wrappedDataKey,
      fingerprint: defaultFingerprint(),
    });
    expect(account.status).toBe("connected");

    // No plaintext at rest (SC-004): raw column bytes must not contain the secret value.
    const raw = await handle.pool.query<{ secret_ciphertext: Buffer }>(
      "SELECT secret_ciphertext FROM connected_account WHERE id = $1",
      [account.id],
    );
    expect(raw.rows[0]!.secret_ciphertext.toString("utf8")).not.toContain("TOP-SECRET");

    // But it decrypts back correctly with the key.
    expect(openSecretString(sealed, MASTER_KEY)).toContain("TOP-SECRET");

    // One account per service: a second insert violates the unique index.
    await expect(
      createAccount(db, {
        serviceId: "epic",
        method: "session_import",
        secretCiphertext: sealed.ciphertext,
        secretDataKey: sealed.wrappedDataKey,
        fingerprint: defaultFingerprint(),
      }),
    ).rejects.toThrow();

    expect((await getAccountByService(db, "epic"))?.id).toBe(account.id);
  });
});
