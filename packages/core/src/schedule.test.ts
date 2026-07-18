import { describe, expect, it } from "vitest";
import { computeNextRun, jitterSeconds } from "./schedule.js";

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
