import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSecretString, sealSecret } from "@uc/core";
import { defaultFingerprint } from "@uc/connectors";
import {
  createAccount,
  createDb,
  getAccountByService,
  getAccountSecret,
  hasConsent,
  recordConsent,
  replaceAccountSecret,
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

maybe("reconnect (integration)", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = createDb(url!);
    await handle.pool.query("DELETE FROM connected_account");
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("keeps the proxy and fingerprint when a reconnect does not supply them", async () => {
    // The extension's reconnect has no proxy field. replaceAccountSecret used to write null for an
    // omitted proxy, so reconnecting silently dropped the one the operator had configured.
    const { db } = handle;
    const secret = sealSecret(JSON.stringify({ cookies: [] }), MASTER_KEY);
    const proxy = sealSecret("socks5://proxy.example:1080", MASTER_KEY);
    const fingerprint = { ...(defaultFingerprint() as object), marker: "original" };
    const account = await createAccount(db, {
      serviceId: "twitch",
      method: "session_import",
      secretCiphertext: secret.ciphertext,
      secretDataKey: secret.wrappedDataKey,
      fingerprint,
      proxyCiphertext: proxy.ciphertext,
      proxyDataKey: proxy.wrappedDataKey,
    });

    const fresh = sealSecret(JSON.stringify({ cookies: [{ name: "auth-token" }] }), MASTER_KEY);
    await replaceAccountSecret(db, account.id, {
      method: "session_import",
      secretCiphertext: fresh.ciphertext,
      secretDataKey: fresh.wrappedDataKey,
    });

    const stored = await getAccountSecret(db, account.id);
    expect(stored?.proxyCiphertext?.equals(proxy.ciphertext)).toBe(true);
    expect(stored?.secretCiphertext.equals(fresh.ciphertext)).toBe(true);
    expect((await getAccountByService(db, "twitch"))?.fingerprint).toMatchObject({ marker: "original" });

    // An explicit null still clears it: that is what the manual form sends for an emptied field.
    await replaceAccountSecret(db, account.id, {
      method: "session_import",
      secretCiphertext: fresh.ciphertext,
      secretDataKey: fresh.wrappedDataKey,
      proxyCiphertext: null,
      proxyDataKey: null,
    });
    expect((await getAccountSecret(db, account.id))?.proxyCiphertext).toBeNull();
  });
});
