import { describe, expect, it } from "vitest";
import { PRIME_SUB_DAYS, applyJitter, computeNextRun, estimateBenefitEnd, jitterSeconds } from "./schedule.js";

describe("computeNextRun (local time)", () => {
  it("daily: later today when the time is still ahead", () => {
    const now = new Date(2026, 6, 18, 8, 0, 0);
    const next = computeNextRun("daily", 9, 0, null, now);
    expect(next.getHours()).toBe(9);
    expect(next.getDate()).toBe(18);
  });

  it("daily: tomorrow when the time already passed", () => {
    const now = new Date(2026, 6, 18, 10, 0, 0);
    const next = computeNextRun("daily", 9, 0, null, now);
    expect(next.getDate()).toBe(19);
    expect(next.getHours()).toBe(9);
  });

  it("weekly: next occurrence of the target weekday", () => {
    const now = new Date(2026, 6, 18, 12, 0, 0); // Saturday
    const next = computeNextRun("weekly", 10, 0, 1, now);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(20);
    expect(next.getHours()).toBe(10);
  });

  it("weekly: same weekday but time passed → next week", () => {
    const now = new Date(2026, 6, 18, 12, 0, 0); // Saturday 12:00
    const next = computeNextRun("weekly", 10, 0, 6, now);
    expect(next.getDay()).toBe(6);
    expect(next.getDate()).toBe(25);
  });
});

describe("jitterSeconds", () => {
  it("stays within [0, max]", () => {
    expect(jitterSeconds(45, () => 0)).toBe(0);
    expect(jitterSeconds(45, () => 0.999999)).toBe(45);
    expect(jitterSeconds(45, () => 0.5)).toBe(23);
  });
});

describe("applyJitter", () => {
  const base = new Date("2026-07-25T09:00:00.000Z");

  it("returns the time unchanged when jitter is zero or negative", () => {
    expect(applyJitter(base, 0).getTime()).toBe(base.getTime());
    expect(applyJitter(base, -5).getTime()).toBe(base.getTime());
  });

  it("shifts earlier at the low end of the RNG range", () => {
    // rand()=0 → offset = -jitter
    expect(applyJitter(base, 30, () => 0).getTime()).toBe(base.getTime() - 30 * 60_000);
  });

  it("shifts later at the high end of the RNG range", () => {
    // rand()→1 → offset = +jitter
    expect(applyJitter(base, 30, () => 0.999999).getTime()).toBe(base.getTime() + 30 * 60_000);
  });

  it("leaves the time unchanged at the midpoint", () => {
    expect(applyJitter(base, 30, () => 0.5).getTime()).toBe(base.getTime());
  });

  it("always stays within the requested window", () => {
    for (const r of [0, 0.13, 0.42, 0.77, 0.99]) {
      const delta = Math.abs(applyJitter(base, 20, () => r).getTime() - base.getTime());
      expect(delta).toBeLessThanOrEqual(20 * 60_000);
    }
  });
});

describe("estimateBenefitEnd", () => {
  it("adds the Prime sub duration by default", () => {
    const claimed = new Date("2026-07-26T10:00:00.000Z");
    expect(estimateBenefitEnd(claimed).toISOString()).toBe("2026-08-25T10:00:00.000Z");
  });

  it("accepts a custom duration", () => {
    const claimed = new Date("2026-07-26T10:00:00.000Z");
    expect(estimateBenefitEnd(claimed, 7).toISOString()).toBe("2026-08-02T10:00:00.000Z");
  });

  it("uses the documented 30-day Prime period", () => {
    expect(PRIME_SUB_DAYS).toBe(30);
  });
});
