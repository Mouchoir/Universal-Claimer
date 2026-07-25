import { describe, expect, it } from "vitest";
import { constantTimeEqual, mintRelayTicket, verifyRelayTicket } from "./relay-ticket.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("relay ticket", () => {
  it("round-trips for the right session before expiry", () => {
    const now = 1_000_000;
    const t = mintRelayTicket(KEY, "sess-1", { now, ttlMs: 60_000 });
    expect(verifyRelayTicket(KEY, t, "sess-1", { now: now + 10_000 })).toBe("sess-1");
  });

  it("rejects a ticket for a different session", () => {
    const t = mintRelayTicket(KEY, "sess-1", { now: 0 });
    expect(verifyRelayTicket(KEY, t, "sess-2", { now: 1 })).toBeNull();
  });

  it("rejects an expired ticket", () => {
    const t = mintRelayTicket(KEY, "sess-1", { now: 0, ttlMs: 1000 });
    expect(verifyRelayTicket(KEY, t, "sess-1", { now: 2000 })).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const t = mintRelayTicket(KEY, "sess-1", { now: 0 });
    const tampered = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifyRelayTicket(KEY, tampered, "sess-1", { now: 1 })).toBeNull();
  });

  it("rejects a ticket signed with a different key", () => {
    const t = mintRelayTicket(KEY, "sess-1", { now: 0 });
    const other = Buffer.alloc(32, 9).toString("base64");
    expect(verifyRelayTicket(other, t, "sess-1", { now: 1 })).toBeNull();
  });

  it("rejects undefined / malformed tickets", () => {
    expect(verifyRelayTicket(KEY, undefined, "s", {})).toBeNull();
    expect(verifyRelayTicket(KEY, "nodot", "s", {})).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings and false otherwise", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
