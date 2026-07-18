/**
 * Assisted-login orchestration (see docs/design/assisted-login.md). Launches an
 * instance-controlled browser at the service login page, lets the operator complete login
 * (directly in local-display mode, or via the frame/input relay in headless mode), detects
 * success, captures + stores the session cookies, and closes the browser. Dependencies are
 * injected so the loop is unit-testable without a real browser.
 */

export type LoginStatus = "awaiting_user" | "connected" | "timed_out" | "failed";

export interface LoginJob {
  sessionId: string;
  serviceId: string;
}

export interface LoginDeps {
  /** Launch the browser at the connector's loginUrl; returns an opaque session token. */
  openSession(): Promise<unknown>;
  closeSession(session: unknown): Promise<void>;
  /** Push a screenshot frame to the dashboard (headless relay). */
  captureFrame(session: unknown, sessionId: string): Promise<void>;
  /** Apply any queued operator input events to the page (headless relay). */
  drainInputs(session: unknown, sessionId: string): Promise<void>;
  /** Has the operator finished logging in? */
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
      await deps.captureFrame(session, job.sessionId);
      await deps.drainInputs(session, job.sessionId);
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
