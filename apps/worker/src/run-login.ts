/**
 * Assisted-login orchestration (see docs/design/assisted-login.md and cdp-relay.md). Launches an
 * instance-controlled browser at the service login page, lets the operator complete login —
 * directly in the native window (local deployment) or via the CDP screencast relay started in
 * `openSession` (headless deployment) — detects that the operator confirmed, captures + stores
 * the session cookies, and closes the browser. Dependencies are injected so the loop is
 * unit-testable without a real browser. The relay is event-driven, so the loop itself only
 * governs the lifecycle: open → awaiting_user → wait for confirm → capture → close.
 */

export type LoginStatus = "awaiting_user" | "connected" | "timed_out" | "failed";

export interface LoginJob {
  sessionId: string;
  serviceId: string;
}

export interface LoginDeps {
  /**
   * Launch the browser at the connector's loginUrl and, in headless relay mode, start the CDP
   * screencast relay. Returns an opaque session token passed back to the other hooks.
   */
  openSession(): Promise<unknown>;
  /** Stop the relay (if any) and close the browser. */
  closeSession(session: unknown): Promise<void>;
  /** Has the operator confirmed they finished logging in? */
  isLoggedIn(session: unknown): Promise<boolean>;
  /** Extract cookies, seal them, and store the connected account. */
  captureCookiesAndStore(session: unknown): Promise<void>;
  setStatus(sessionId: string, status: LoginStatus): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface LoginOptions {
  timeoutMs: number;
  pollMs: number;
}

export async function runLogin(
  deps: LoginDeps,
  job: LoginJob,
  opts: LoginOptions = { timeoutMs: 5 * 60 * 1000, pollMs: 800 },
): Promise<void> {
  const session = await deps.openSession();
  await deps.setStatus(job.sessionId, "awaiting_user");
  try {
    const deadline = deps.now() + opts.timeoutMs;
    while (deps.now() < deadline) {
      if (await deps.isLoggedIn(session)) {
        await deps.captureCookiesAndStore(session);
        await deps.setStatus(job.sessionId, "connected");
        return;
      }
      await deps.sleep(opts.pollMs);
    }
    await deps.setStatus(job.sessionId, "timed_out");
  } catch {
    await deps.setStatus(job.sessionId, "failed");
  } finally {
    await deps.closeSession(session);
  }
}
