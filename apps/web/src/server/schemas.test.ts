import { describe, expect, it } from "vitest";
import {
  connectAccountSchema,
  consentSchema,
  loginSchema,
  recoverSchema,
  setupSchema,
} from "./schemas.js";

describe("API request schemas (contract)", () => {
  it("setup requires an 8+ char password and, if present, exactly 3 recovery questions", () => {
    expect(setupSchema.safeParse({ password: "12345678" }).success).toBe(true);
    expect(setupSchema.safeParse({ password: "short" }).success).toBe(false);
    expect(
      setupSchema.safeParse({
        password: "12345678",
        recovery: [{ question: "q", answer: "a" }],
      }).success,
    ).toBe(false);
    expect(
      setupSchema.safeParse({
        password: "12345678",
        webhook: { kind: "discord", url: "not-a-url" },
      }).success,
    ).toBe(false);
  });

  it("login requires a non-empty password", () => {
    expect(loginSchema.safeParse({ password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ password: "" }).success).toBe(false);
  });

  it("recover requires exactly 3 answers and an 8+ char password", () => {
    expect(recoverSchema.safeParse({ answers: ["a", "b", "c"], newPassword: "12345678" }).success).toBe(
      true,
    );
    expect(recoverSchema.safeParse({ answers: ["a", "b"], newPassword: "12345678" }).success).toBe(
      false,
    );
  });

  it("consent requires accepted === true", () => {
    expect(consentSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(consentSchema.safeParse({ accepted: false }).success).toBe(false);
  });

  it("connect account discriminates on method", () => {
    expect(
      connectAccountSchema.safeParse({
        serviceId: "epic",
        method: "session_import",
        cookiesText: "x",
      }).success,
    ).toBe(true);
    expect(
      connectAccountSchema.safeParse({
        serviceId: "epic",
        method: "credential_totp",
        email: "a@b.com",
        password: "pw",
      }).success,
    ).toBe(true);
    expect(
      connectAccountSchema.safeParse({
        serviceId: "epic",
        method: "credential_totp",
        email: "not-email",
        password: "pw",
      }).success,
    ).toBe(false);
  });
});
