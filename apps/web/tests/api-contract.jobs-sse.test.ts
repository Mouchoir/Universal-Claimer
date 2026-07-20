import { describe, expect, it } from "vitest";
import {
  jobViewSchema,
  loginInputSchema,
  missingConfigKeys,
  scheduleSchema,
  sseJobsEventSchema,
} from "../src/server/schemas.js";

/** Contract test for the jobs API + SSE event payload shapes (US3 / T035a). */
describe("jobs & SSE payload contract", () => {
  const job = {
    id: "j1",
    connectedAccountId: "a1",
    serviceId: "epic",
    state: "succeeded",
    outcome: "claimed",
    summary: "Claimed: Game X",
    // Extra serialized fields (dates) are tolerated.
    createdAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:01:00.000Z",
  };

  it("accepts a valid job view", () => {
    expect(jobViewSchema.safeParse(job).success).toBe(true);
  });

  it("accepts null outcome for an in-flight job", () => {
    expect(
      jobViewSchema.safeParse({ ...job, state: "running", outcome: null, summary: null }).success,
    ).toBe(true);
  });

  it("rejects an unknown state or outcome", () => {
    expect(jobViewSchema.safeParse({ ...job, state: "bogus" }).success).toBe(false);
    expect(jobViewSchema.safeParse({ ...job, outcome: "bogus" }).success).toBe(false);
  });

  it("validates the SSE jobs event envelope", () => {
    expect(sseJobsEventSchema.safeParse({ type: "jobs", jobs: [job] }).success).toBe(true);
    expect(sseJobsEventSchema.safeParse({ type: "other", jobs: [] }).success).toBe(false);
  });

  it("validates login input events by kind", () => {
    expect(loginInputSchema.safeParse({ kind: "click", x: 10, y: 20 }).success).toBe(true);
    expect(loginInputSchema.safeParse({ kind: "type", text: "hello" }).success).toBe(true);
    expect(loginInputSchema.safeParse({ kind: "key", key: "Enter" }).success).toBe(true);
    expect(loginInputSchema.safeParse({ kind: "click", x: 10 }).success).toBe(false);
    expect(loginInputSchema.safeParse({ kind: "bogus" }).success).toBe(false);
  });

  it("validates schedules and requires dayOfWeek for weekly", () => {
    expect(
      scheduleSchema.safeParse({ frequency: "daily", hour: 9, minute: 0, enabled: true }).success,
    ).toBe(true);
    expect(
      scheduleSchema.safeParse({ frequency: "weekly", hour: 9, minute: 0, dayOfWeek: 1, enabled: true })
        .success,
    ).toBe(true);
    // weekly without dayOfWeek is rejected
    expect(
      scheduleSchema.safeParse({ frequency: "weekly", hour: 9, minute: 0, enabled: true }).success,
    ).toBe(false);
    // out-of-range hour
    expect(
      scheduleSchema.safeParse({ frequency: "daily", hour: 24, minute: 0, enabled: true }).success,
    ).toBe(false);
  });

  it("missingConfigKeys reports unmet required connector config", () => {
    const fields = [{ key: "channel", required: true }];
    expect(missingConfigKeys(fields, { channel: "ninja" })).toEqual([]);
    expect(missingConfigKeys(fields, {})).toEqual(["channel"]);
    expect(missingConfigKeys(fields, { channel: "   " })).toEqual(["channel"]);
    expect(missingConfigKeys(undefined, {})).toEqual([]);
  });
});
