import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger } from "@uc/core";
import type { Connector, ConnectorContext } from "@uc/connectors";
import { runClaim, type ClaimJobDeps, type ClaimOutcome, type LoadedAccount } from "./run-claim.js";

const fingerprint = {
  userAgent: "ua",
  timezoneId: "UTC",
  locale: "en-US",
  viewport: { width: 1, height: 1 },
};

const account: LoadedAccount = {
  method: "session_import",
  serviceId: "epic",
  fingerprint,
  secretJson: JSON.stringify({ cookies: [{ name: "c", value: "v" }] }),
  config: {},
};

function makeCtx(): ConnectorContext {
  return {
    browser: { launch: async () => ({ context: {} as never }), close: async () => {} },
    captcha: new NullCaptchaSolver(),
    totp: () => "000000",
    emit: () => {},
    log: createLogger({ sink: () => {} }),
  };
}

function makeDeps(overrides: {
  connector: Partial<Connector>;
  account?: LoadedAccount | null;
}): { deps: ClaimJobDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    markRunning: [],
    finish: [],
    pauseForHumanAction: [],
    markNeedsReauth: [],
    recordRun: [],
    notify: [],
  };
  const connector: Connector = {
    id: "epic",
    version: "0.1.0",
    methods: ["session_import"],
    authenticate: async () => ({ ok: true, fingerprint }),
    claim: async () => ({ outcome: "nothing_to_claim", summary: "" }),
    healthCheck: async () => ({ healthy: true }),
    ...overrides.connector,
  };
  const deps: ClaimJobDeps = {
    getConnector: () => connector,
    loadAccount: async () =>
      overrides.account === undefined ? account : overrides.account,
    markRunning: async (id) => void calls.markRunning!.push(id),
    finish: async (id, outcome, summary) => void calls.finish!.push([id, outcome, summary]),
    pauseForHumanAction: async (id, summary) => void calls.pauseForHumanAction!.push([id, summary]),
    markNeedsReauth: async (id) => void calls.markNeedsReauth!.push(id),
    recordRun: async (s, v, ok, o) => void calls.recordRun!.push([s, v, ok, o]),
    notify: async (m) => void calls.notify!.push(m),
    makeContext: makeCtx,
  };
  return { deps, calls };
}

const job = { jobId: "j1", connectedAccountId: "a1", serviceId: "epic" };

describe("runClaim orchestration", () => {
  it("marks running then finishes with the connector outcome", async () => {
    const { deps, calls } = makeDeps({
      connector: { claim: async () => ({ outcome: "claimed", summary: "Claimed: Game X" }) },
    });
    await runClaim(deps, job);
    expect(calls.markRunning).toEqual(["j1"]);
    expect(calls.finish).toEqual([["j1", "claimed", "Claimed: Game X"]]);
    expect(calls.recordRun).toEqual([["epic", "0.1.0", true, "claimed"]]);
  });

  it("treats nothing_to_claim as a success for health accounting", async () => {
    const { deps, calls } = makeDeps({
      connector: { claim: async () => ({ outcome: "nothing_to_claim", summary: "" }) },
    });
    await runClaim(deps, job);
    expect(calls.recordRun).toEqual([["epic", "0.1.0", true, "nothing_to_claim"]]);
  });

  it("flags the account for re-auth on reauth_needed", async () => {
    const { deps, calls } = makeDeps({
      connector: { claim: async () => ({ outcome: "reauth_needed", summary: "expired" }) },
    });
    await runClaim(deps, job);
    expect(calls.markNeedsReauth).toEqual(["a1"]);
    expect(calls.recordRun).toEqual([["epic", "0.1.0", false, "reauth_needed"]]);
  });

  it("still finishes the job (failed) when the connector throws", async () => {
    const { deps, calls } = makeDeps({
      connector: {
        claim: async () => {
          throw new Error("boom");
        },
      },
    });
    await runClaim(deps, job);
    expect(calls.finish).toHaveLength(1);
    expect((calls.finish[0] as unknown[])[1]).toBe("failed");
  });

  it("pauses (not finishes) and notifies on requires_human_action", async () => {
    const { deps, calls } = makeDeps({
      connector: {
        claim: async () => ({ outcome: "requires_human_action", summary: "captcha needed" }),
      },
    });
    await runClaim(deps, job);
    expect(calls.pauseForHumanAction).toEqual([["j1", "captcha needed"]]);
    expect(calls.finish).toHaveLength(0); // non-terminal — not finished
    expect(calls.recordRun).toHaveLength(0); // no health accounting for a pause
    expect(calls.notify).toHaveLength(1);
  });

  it("fails cleanly when the account is missing", async () => {
    const { deps, calls } = makeDeps({ connector: {}, account: null });
    await runClaim(deps, job);
    expect(calls.finish).toEqual([["j1", "failed", "connected account not found"]]);
  });
});
