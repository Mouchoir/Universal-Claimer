import { describe, expect, it } from "vitest";
import {
  AnswersIncorrectError,
  RecoveryDisabledError,
  SetupAlreadyDoneError,
  isSetupNeeded,
  recoverPassword,
  resetPassword,
  setupAdmin,
  verifyLogin,
  type AdminRecord,
  type AdminStore,
  type SecurityQ,
} from "./admin-service.js";

/** In-memory AdminStore for unit tests (no database). */
class FakeStore implements AdminStore {
  admin: AdminRecord | null = null;
  questions: SecurityQ[] = [];
  async getAdmin() {
    return this.admin;
  }
  async createAdmin(passwordHash: string, recoveryEnabled: boolean) {
    if (this.admin) throw new Error("unique violation");
    this.admin = { id: "1", passwordHash, recoveryEnabled };
    return this.admin;
  }
  async updatePassword(passwordHash: string) {
    if (this.admin) this.admin.passwordHash = passwordHash;
  }
  async getSecurityQuestions() {
    return this.questions;
  }
  async replaceSecurityQuestions(qs: SecurityQ[]) {
    this.questions = qs;
  }
}

const recovery = [
  { question: "First pet?", answer: "Rex" },
  { question: "Birth city?", answer: "Lyon" },
  { question: "Favorite game?", answer: "Portal" },
];

describe("admin-service", () => {
  it("reports setup needed until an admin exists", async () => {
    const store = new FakeStore();
    expect(await isSetupNeeded(store)).toBe(true);
    await setupAdmin(store, { password: "correct horse" });
    expect(await isSetupNeeded(store)).toBe(false);
  });

  it("rejects a second setup", async () => {
    const store = new FakeStore();
    await setupAdmin(store, { password: "correct horse" });
    await expect(setupAdmin(store, { password: "another one" })).rejects.toBeInstanceOf(
      SetupAlreadyDoneError,
    );
  });

  it("requires exactly 3 recovery questions when recovery is enabled", async () => {
    const store = new FakeStore();
    await expect(
      setupAdmin(store, { password: "correct horse", recovery: recovery.slice(0, 2) }),
    ).rejects.toThrow(/exactly 3/);
  });

  it("verifies login correctly", async () => {
    const store = new FakeStore();
    await setupAdmin(store, { password: "correct horse" });
    expect(await verifyLogin(store, "correct horse")).toBe(true);
    expect(await verifyLogin(store, "wrong")).toBe(false);
  });

  it("recovers with all three correct answers (case/space-insensitive)", async () => {
    const store = new FakeStore();
    await setupAdmin(store, { password: "correct horse", recovery });
    await recoverPassword(store, ["  rex ", "LYON", "portal"], "new password!");
    expect(await verifyLogin(store, "new password!")).toBe(true);
  });

  it("rejects recovery with a wrong answer", async () => {
    const store = new FakeStore();
    await setupAdmin(store, { password: "correct horse", recovery });
    await expect(
      recoverPassword(store, ["Rex", "Paris", "Portal"], "new password!"),
    ).rejects.toBeInstanceOf(AnswersIncorrectError);
  });

  it("rejects recovery when disabled", async () => {
    const store = new FakeStore();
    await setupAdmin(store, { password: "correct horse" });
    await expect(recoverPassword(store, ["a", "b", "c"], "x")).rejects.toBeInstanceOf(
      RecoveryDisabledError,
    );
  });

  it("host-side reset changes the password unconditionally", async () => {
    const store = new FakeStore();
    await setupAdmin(store, { password: "correct horse" });
    await resetPassword(store, "reset password!");
    expect(await verifyLogin(store, "reset password!")).toBe(true);
  });
});
