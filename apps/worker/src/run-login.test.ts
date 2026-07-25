import { describe, expect, it } from "vitest";
import { runLogin, type LoginDeps, type LoginStatus } from "./run-login.js";

function makeDeps(over: {
  loggedInAfter: number; // becomes logged-in on the Nth poll (1-based); Infinity = never
}): { deps: LoginDeps; calls: Record<string, unknown[]>; time: { t: number } } {
  const calls: Record<string, unknown[]> = {
    store: [],
    status: [],
    close: [],
  };
  const time = { t: 0 };
  let checks = 0;
  const deps: LoginDeps = {
    openSession: async () => ({ id: "sess" }),
    closeSession: async (s) => void calls.close!.push(s),
    isLoggedIn: async () => {
      checks += 1;
      return checks >= over.loggedInAfter;
    },
    captureCookiesAndStore: async (s) => void calls.store!.push(s),
    setStatus: async (_id, status: LoginStatus) => void calls.status!.push(status),
    sleep: async (ms) => {
      time.t += ms;
    },
    now: () => time.t,
  };
  return { deps, calls, time };
}

const job = { sessionId: "s1", serviceId: "epic" };

describe("runLogin", () => {
  it("captures cookies and connects once the operator logs in", async () => {
    const { deps, calls } = makeDeps({ loggedInAfter: 2 });
    await runLogin(deps, job, { timeoutMs: 10_000, pollMs: 800 });
    expect(calls.status).toEqual(["awaiting_user", "connected"]);
    expect(calls.store).toHaveLength(1);
    expect(calls.close).toHaveLength(1);
  });

  it("times out if the operator never logs in, and always closes the browser", async () => {
    const { deps, calls } = makeDeps({ loggedInAfter: Number.POSITIVE_INFINITY });
    await runLogin(deps, job, { timeoutMs: 2400, pollMs: 800 });
    expect(calls.status).toEqual(["awaiting_user", "timed_out"]);
    expect(calls.store).toHaveLength(0);
    expect(calls.close).toHaveLength(1);
  });

  it("marks failed and still closes on an unexpected error", async () => {
    const { deps, calls } = makeDeps({ loggedInAfter: 1 });
    deps.captureCookiesAndStore = async () => {
      throw new Error("extract failed");
    };
    await runLogin(deps, job, { timeoutMs: 10_000, pollMs: 800 });
    expect(calls.status).toContain("failed");
    expect(calls.close).toHaveLength(1);
  });
});
