import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./session.js";

const key = randomBytes(32).toString("base64");

describe("session token", () => {
  it("round-trips a valid token", () => {
    const now = 1_000_000;
    const token = createSessionToken(key, { iat: now });
    const payload = verifySessionToken(key, token, { now: now + 1000 });
    expect(payload).toEqual({ iat: now });
  });

  it("rejects a token signed with a different key", () => {
    const token = createSessionToken(key, { iat: Date.now() });
    const otherKey = randomBytes(32).toString("base64");
    expect(verifySessionToken(otherKey, token)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = createSessionToken(key, { iat: Date.now() });
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    expect(verifySessionToken(key, tampered)).toBeNull();
  });

  it("rejects an expired token", () => {
    const iat = 1_000_000;
    const token = createSessionToken(key, { iat });
    expect(verifySessionToken(key, token, { maxAgeMs: 1000, now: iat + 2000 })).toBeNull();
  });

  it("rejects undefined / malformed tokens", () => {
    expect(verifySessionToken(key, undefined)).toBeNull();
    expect(verifySessionToken(key, "garbage")).toBeNull();
    expect(verifySessionToken(key, ".")).toBeNull();
  });
});
