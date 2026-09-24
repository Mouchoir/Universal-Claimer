import type {
  AccountFacts,
  AuthInput,
  BrowserCookie,
  ClaimedItem,
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
/** Per-run callbacks the worker injects into the connector context. */
export interface ConnectorHooks {
  persistRefreshedSession(cookies: BrowserCookie[]): Promise<void>;
}

export interface ClaimJobDeps {
  getConnector(serviceId: string): Connector;
  loadAccount(connectedAccountId: string): Promise<LoadedAccount | null>;
  markRunning(jobId: string): Promise<void>;
  finish(jobId: string, outcome: ClaimOutcome, summary: string): Promise<void>;
  /** Pause a job awaiting human action (non-terminal). */
  pauseForHumanAction(jobId: string, summary: string): Promise<void>;
  markNeedsReauth(connectedAccountId: string): Promise<void>;
  /**
   * Clear a needs-reauth flag once a run proves the session works. Without it the flag was
   * permanent: a verdict that turned out wrong — a connector bug, a transient page — left the
   * account marked dead until it was reconnected, however many runs then succeeded.
   */
  markConnected(connectedAccountId: string): Promise<void>;
  recordRun(serviceId: string, version: string, success: boolean, outcome: ClaimOutcome): Promise<void>;
  /**
   * Persist what the run obtained (one claim_event per item) and any account facts it observed
   * (username, active entitlements) — the data behind the dashboard's history and stats.
   */
  recordInsights(input: {
    jobId: string;
    connectedAccountId: string;
    serviceId: string;
    claimedItems?: ClaimedItem[];
    accountFacts?: AccountFacts;
  }): Promise<void>;
  /** Best-effort operator notification (portal SSE + optional webhook). */
  notify(message: string): Promise<void>;
  /** Build a connector context whose browser uses the given per-account proxy (if any). */
  makeContext(proxy?: string, hooks?: ConnectorHooks): ConnectorContext;
  /**
   * Persist session cookies a connector refreshed during a run, so a stored session does not
   * expire while the operator's own browser stays signed in.
   */
  persistRefreshedSession(connectedAccountId: string, cookies: BrowserCookie[]): Promise<void>;
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
/** One-line, bounded description of an error, for a summary read in a list of runs. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  // Collapsed onto one line rather than truncated at the first: a Playwright error puts the
  // useful part — the selector, the timeout that expired — on the lines after its summary.
  const flat = (err.message || err.name || "unknown").replace(/\s+/g, ' ').trim();
  // Bounded because this lands in the run history beside every other line.
  return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat || err.name;
}

export async function runClaim(deps: ClaimJobDeps, job: ClaimJob): Promise<void> {
  await deps.markRunning(job.jobId);

  const account = await deps.loadAccount(job.connectedAccountId);
  if (!account) {
    await deps.finish(job.jobId, "failed", "connected account not found");
    return;
  }

  const connector = deps.getConnector(account.serviceId);
  const input = toAuthInput(account.method, account.secretJson);
  // Let the connector hand back refreshed cookies for this account (see ConnectorContext).
  const ctx = deps.makeContext(account.proxy, {
    persistRefreshedSession: (cookies) => deps.persistRefreshedSession(job.connectedAccountId, cookies),
  });

  let result: {
    outcome: ClaimOutcome;
    summary: string;
    claimedItems?: ClaimedItem[];
    accountFacts?: AccountFacts;
  };
  try {
    result = await connector.claim(input, account.fingerprint, account.config, ctx);
  } catch (err) {
    // The message, not the name. `err.name` is "Error" for anything thrown without a subclass,
    // which is most things — so every unexpected failure read as "claim error: Error" and told
    // the operator nothing at all. Playwright's messages, by contrast, name the selector and the
    // timeout that expired.
    //
    // Truncated because a stack-laden message would swamp the run history it is displayed in,
    // and the first line is where the cause is.
    result = { outcome: "failed", summary: `claim error: ${describeError(err)}` };
  }

  // Record history + account facts before branching on the outcome, so facts observed during a
  // run are kept even when nothing was claimed. Never let this fail the job.
  if (result.claimedItems?.length || result.accountFacts) {
    await deps
      .recordInsights({
        jobId: job.jobId,
        connectedAccountId: job.connectedAccountId,
        serviceId: account.serviceId,
        claimedItems: result.claimedItems,
        accountFacts: result.accountFacts,
      })
      .catch(() => undefined);
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
  if (success) await deps.markConnected(job.connectedAccountId);
  await deps.recordRun(account.serviceId, connector.version, success, result.outcome);

  if (result.outcome === "failed" || result.outcome === "reauth_needed") {
    await deps.notify(`Claim for ${account.serviceId} ${result.outcome}: ${result.summary}`);
  }
}
