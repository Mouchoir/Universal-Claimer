import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "./rate-limit.js";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to max attempts then blocks within the window", () => {
    const t0 = 1_000_000;
    expect(rateLimit("login", 3, 1000, t0)).toBe(true);
    expect(rateLimit("login", 3, 1000, t0)).toBe(true);
    expect(rateLimit("login", 3, 1000, t0)).toBe(true);
    expect(rateLimit("login", 3, 1000, t0)).toBe(false);
  });

  it("resets after the window elapses", () => {
    const t0 = 1_000_000;
    rateLimit("login", 1, 1000, t0);
    expect(rateLimit("login", 1, 1000, t0)).toBe(false);
    expect(rateLimit("login", 1, 1000, t0 + 1001)).toBe(true);
  });

  it("keys are independent", () => {
    const t0 = 1_000_000;
    rateLimit("login", 1, 1000, t0);
    expect(rateLimit("recover", 1, 1000, t0)).toBe(true);
  });
});
