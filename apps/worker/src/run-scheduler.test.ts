import { describe, expect, it } from "vitest";
import type { ScheduleRow } from "@uc/db";
import { runScheduler, type SchedulerDeps } from "./run-scheduler.js";

function sched(id: string, accountId: string, enabled = true): ScheduleRow {
  return {
    id,
    connectedAccountId: accountId,
    frequency: "daily",
    hour: 9,
    minute: 0,
    dayOfWeek: null,
    enabled,
    nextRunAt: new Date(0),
    lastRunAt: null,
  };
}

function makeDeps(over: {
  due: ScheduleRow[];
  active?: Set<string>;
}): { deps: SchedulerDeps; calls: { enqueued: string[]; advanced: string[] } } {
  const active = over.active ?? new Set<string>();
  const calls = { enqueued: [] as string[], advanced: [] as string[] };
  const deps: SchedulerDeps = {
    now: () => new Date(1_000_000),
    listDue: async () => over.due,
    hasActiveJob: async (id) => active.has(id),
    enqueueClaim: async (id) => {
      calls.enqueued.push(id);
      return true;
    },
    advance: async (s) => void calls.advanced.push(s.id),
  };
  return { deps, calls };
}

describe("runScheduler", () => {
  it("enqueues a claim for a due account and advances it", async () => {
    const { deps, calls } = makeDeps({ due: [sched("s1", "a1")] });
    const n = await runScheduler(deps);
    expect(n).toBe(1);
    expect(calls.enqueued).toEqual(["a1"]);
    expect(calls.advanced).toEqual(["s1"]);
  });

  it("skips enqueue when a claim is already active, but still advances", async () => {
    const { deps, calls } = makeDeps({ due: [sched("s1", "a1")], active: new Set(["a1"]) });
    const n = await runScheduler(deps);
    expect(n).toBe(0);
    expect(calls.enqueued).toEqual([]);
    expect(calls.advanced).toEqual(["s1"]); // advanced regardless
  });

  it("does not enqueue a disabled schedule but still advances it", async () => {
    const { deps, calls } = makeDeps({ due: [sched("s1", "a1", false)] });
    await runScheduler(deps);
    expect(calls.enqueued).toEqual([]);
    expect(calls.advanced).toEqual(["s1"]);
  });

  it("handles several due schedules", async () => {
    const { deps, calls } = makeDeps({
      due: [sched("s1", "a1"), sched("s2", "a2")],
    });
    const n = await runScheduler(deps);
    expect(n).toBe(2);
    expect(calls.enqueued.sort()).toEqual(["a1", "a2"]);
  });
});
