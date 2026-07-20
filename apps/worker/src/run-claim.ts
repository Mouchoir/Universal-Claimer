import type {
  AuthInput,
  BrowserCookie,
  Connector,
  ConnectorContext,
  Fingerprint,
} from "@uc/connectors";

export type ClaimOutcome =
  | "claimed"
  | "nothing_to_claim"
  | "failed"
  | "reauth_needed"
  | "requires_human_action";

export interface ClaimJob {
  jobId: string;
  connectedAccountId: string;
  serviceId: string;
}

export interface LoadedAccount {
  method: "session_import" | "credential_totp";
  serviceId: string;
  fingerprint: Fingerprint;
  /** Decrypted secret payload as JSON (cookies, or credentials + TOTP seed). */
  secretJson: string;
  /** Per-account connector config (e.g. { channel } for Twitch). */
  config: Record<string, string>;
  /** Decrypted per-account proxy URL, if any (Principle VII). */
  proxy?: string;
}

/**
 * Dependencies for a claim run, injected so the orchestration is unit-testable with fakes
 * (no DB, no browser). Production wiring lives in index.ts.
 */
export interface ClaimJobDeps {
  getConnector(serviceId: string): Connector;
  loadAccount(connectedAccountId: string): Promise<LoadedAccount | null>;
  markRunning(jobId: string): Promise<void>;
  finish(jobId: string, outcome: ClaimOutcome, summary: string): Promise<void>;
  /** Pause a job awaiting human action (non-terminal). */
  pauseForHumanAction(jobId: string, summary: string): Promise<void>;
  markNeedsReauth(connectedAccountId: string): Promise<void>;
  recordRun(serviceId: string, version: string, success: boolean, outcome: ClaimOutcome): Promise<void>;
  /** Best-effort operator notification (portal SSE + optional webhook). */
  notify(message: string): Promise<void>;
  /** Build a connector context whose browser uses the given per-account proxy (if any). */
  makeContext(proxy?: string): ConnectorContext;
}

function toAuthInput(method: LoadedAccount["method"], secretJson: string): AuthInput {
  const p = JSON.parse(secretJson) as Record<string, unknown>;
  if (method === "session_import") {
    return { method: "session_import", cookies: (p.cookies as BrowserCookie[]) ?? [] };
  }
  return {
    method: "credential_totp",
    email: String(p.email),
    password: String(p.password),
    totpSeed: p.totpSeed ? String(p.totpSeed) : undefined,
  };
}

/**
 * Run a single claim to a persisted terminal outcome (FR-011): mark running, load + decrypt
 * the account secret, run the connector, persist the outcome, flag re-auth if needed, and
 * record the run for the health monitor. Always finishes the job — even on error.
 */
export async function runClaim(deps: ClaimJobDeps, job: ClaimJob): Promise<void> {
  await deps.markRunning(job.jobId);

  const account = await deps.loadAccount(job.connectedAccountId);
  if (!account) {
    await deps.finish(job.jobId, "failed", "connected account not found");
    return;
  }

  const connector = deps.getConnector(account.serviceId);
  const input = toAuthInput(account.method, account.secretJson);
  const ctx = deps.makeContext(account.proxy);

  let result: { outcome: ClaimOutcome; summary: string };
  try {
    result = await connector.claim(input, account.fingerprint, account.config, ctx);
  } catch (err) {
    result = { outcome: "failed", summary: `claim error: ${err instanceof Error ? err.name : "unknown"}` };
  }

  // Human action needed → pause (non-terminal), notify, and stop here (no terminal outcome,
  // no health accounting). The operator resumes via the human-action endpoint.
  if (result.outcome === "requires_human_action") {
    await deps.pauseForHumanAction(job.jobId, result.summary);
    await deps.notify(`Claim for ${account.serviceId} needs your attention: ${result.summary}`);
    return;
  }

  if (result.outcome === "reauth_needed") {
    await deps.markNeedsReauth(job.connectedAccountId);
  }
  await deps.finish(job.jobId, result.outcome, result.summary);

  const success = result.outcome === "claimed" || result.outcome === "nothing_to_claim";
  await deps.recordRun(account.serviceId, connector.version, success, result.outcome);

  if (result.outcome === "failed" || result.outcome === "reauth_needed") {
    await deps.notify(`Claim for ${account.serviceId} ${result.outcome}: ${result.summary}`);
  }
}
