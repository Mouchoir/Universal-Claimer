import { describe, expect, it } from "vitest";
import {
  listRecoveryQuestions,
  recoverPassword,
  setupAdmin,
  verifyLogin,
  type AdminRecord,
  type AdminStore,
  type SecurityQ,
} from "../src/server/admin-service.js";

/**
 * Unit coverage for the credential round-trip, with an in-memory store. The DB-backed variant
 * lives in onboarding.integration.test.ts and is gated on a Postgres being available; these run
 * everywhere, which is what a password that cannot be saved needs.
 */
function fakeStore(): AdminStore {
  let admin: AdminRecord | null = null;
  let questions: SecurityQ[] = [];
  return {
    getAdmin: async () => admin,
    createAdmin: async (passwordHash, recoveryEnabled) => {
      admin = { id: "admin", passwordHash, recoveryEnabled };
      return admin;
    },
    updatePassword: async (passwordHash) => {
      if (admin) admin = { ...admin, passwordHash };
    },
    getSecurityQuestions: async () => questions,
    replaceSecurityQuestions: async (qs) => {
      questions = qs;
    },
  };
}

const RECOVERY = [
  { question: "First pet?", answer: "Rex" },
  { question: "Birth city?", answer: "Lyon" },
  { question: "First car?", answer: "Clio" },
];

/**
 * Reported as impossible to save. Exercises the characters a form or a query string would
 * mangle if the password ever travelled anywhere but a JSON body: %, &, #, $, ^, @, !.
 */
const GNARLY = "%Q4Z2j7kp@0#B^&@e28$B^@7RjnZAVMHp!ucJ";

describe("admin credential round-trip", () => {
  it("accepts a long password full of URL-significant characters", async () => {
    const store = fakeStore();
    await setupAdmin(store, { password: GNARLY });

    expect(await verifyLogin(store, GNARLY)).toBe(true);
    expect(await verifyLogin(store, GNARLY.slice(0, -1))).toBe(false);
  });

  it("resets to such a password through the recovery flow", async () => {
    const store = fakeStore();
    await setupAdmin(store, { password: "initial-password", recovery: RECOVERY });

    await recoverPassword(store, ["Rex", "Lyon", "Clio"], GNARLY);

    expect(await verifyLogin(store, GNARLY)).toBe(true);
    expect(await verifyLogin(store, "initial-password")).toBe(false);
  });

  it("matches security answers regardless of case and surrounding spacing", async () => {
    const store = fakeStore();
    await setupAdmin(store, { password: "initial-password", recovery: RECOVERY });

    await recoverPassword(store, ["  rEx ", "LYON", "clio"], "another-password");

    expect(await verifyLogin(store, "another-password")).toBe(true);
  });

  it("collapses runs of whitespace inside an answer", async () => {
    const store = fakeStore();
    await setupAdmin(store, {
      password: "initial-password",
      recovery: [
        { question: "Full name?", answer: "Ada  Lovelace" },
        ...RECOVERY.slice(1),
      ],
    });

    await recoverPassword(store, ["ada lovelace", "Lyon", "Clio"], "another-password");

    expect(await verifyLogin(store, "another-password")).toBe(true);
  });

  it("rejects a password under 8 characters on both paths", async () => {
    const setup = fakeStore();
    await expect(setupAdmin(setup, { password: "short" })).rejects.toThrow(/8 characters/);

    const recover = fakeStore();
    await setupAdmin(recover, { password: "initial-password", recovery: RECOVERY });
    await expect(
      recoverPassword(recover, ["Rex", "Lyon", "Clio"], "short"),
    ).rejects.toThrow(/8 characters/);
  });
});

describe("listRecoveryQuestions", () => {
  it("returns the questions in position order, without the answer hashes", async () => {
    const store = fakeStore();
    await setupAdmin(store, { password: "initial-password", recovery: RECOVERY });

    const prompts = await listRecoveryQuestions(store);

    expect(prompts).toEqual([
      { position: 1, question: "First pet?" },
      { position: 2, question: "Birth city?" },
      { position: 3, question: "First car?" },
    ]);
    // The hash must never travel to an unauthenticated caller.
    expect(JSON.stringify(prompts)).not.toContain("$argon2");
  });

  it("sorts by position even when the store returns them shuffled", async () => {
    const store = fakeStore();
    await setupAdmin(store, { password: "initial-password", recovery: RECOVERY });
    const stored = await store.getSecurityQuestions();
    await store.replaceSecurityQuestions([...stored].reverse());

    expect((await listRecoveryQuestions(store)).map((p) => p.position)).toEqual([1, 2, 3]);
  });

  it("returns nothing when recovery was never enabled", async () => {
    const store = fakeStore();
    await setupAdmin(store, { password: "initial-password" });

    expect(await listRecoveryQuestions(store)).toEqual([]);
  });

  it("returns nothing before setup", async () => {
    expect(await listRecoveryQuestions(fakeStore())).toEqual([]);
  });
});
