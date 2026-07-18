/**
 * Captcha solving is the middle layer of the anti-detection strategy (Constitution
 * Principle V): the anti-detect browser prevents most challenges, this solver handles the
 * rest, and unsolved challenges fall back to the human-action flow. Behind an interface so
 * the provider is swappable and connectors can be tested with a stub.
 */

export type CaptchaTask =
  | { type: "recaptcha_v2"; websiteURL: string; websiteKey: string }
  | {
      type: "recaptcha_v3";
      websiteURL: string;
      websiteKey: string;
      minScore?: number;
      pageAction?: string;
    }
  | { type: "hcaptcha"; websiteURL: string; websiteKey: string }
  | { type: "turnstile"; websiteURL: string; websiteKey: string };

export interface CaptchaSolver {
  /** Returns the solution token, or null if solving is unavailable or failed. */
  solve(task: CaptchaTask): Promise<string | null>;
}

/** Used when no captcha key is configured: always defers to the human-action flow. */
export class NullCaptchaSolver implements CaptchaSolver {
  async solve(): Promise<string | null> {
    return null;
  }
}

function toAntiCaptchaTask(task: CaptchaTask): Record<string, unknown> {
  switch (task.type) {
    case "recaptcha_v2":
      return {
        type: "RecaptchaV2TaskProxyless",
        websiteURL: task.websiteURL,
        websiteKey: task.websiteKey,
      };
    case "recaptcha_v3":
      return {
        type: "RecaptchaV3TaskProxyless",
        websiteURL: task.websiteURL,
        websiteKey: task.websiteKey,
        minScore: task.minScore ?? 0.3,
        pageAction: task.pageAction,
      };
    case "hcaptcha":
      return {
        type: "HCaptchaTaskProxyless",
        websiteURL: task.websiteURL,
        websiteKey: task.websiteKey,
      };
    case "turnstile":
      return {
        type: "TurnstileTaskProxyless",
        websiteURL: task.websiteURL,
        websiteKey: task.websiteKey,
      };
  }
}

export interface AntiCaptchaOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * anti-captcha.com solver. Creates a proxyless task and polls until it resolves. Returns
 * null (rather than throwing) on any failure, so the caller cleanly falls back to the
 * human-action flow.
 */
export class AntiCaptchaSolver implements CaptchaSolver {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(opts: AntiCaptchaOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.anti-captcha.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.timeoutMs = opts.timeoutMs ?? 120000;
  }

  async solve(task: CaptchaTask): Promise<string | null> {
    try {
      const created = await this.post("/createTask", {
        clientKey: this.apiKey,
        task: toAntiCaptchaTask(task),
      });
      if (created.errorId !== 0 || typeof created.taskId !== "number") return null;

      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        await this.sleep(this.pollIntervalMs);
        const result = await this.post("/getTaskResult", {
          clientKey: this.apiKey,
          taskId: created.taskId,
        });
        if (result.errorId !== 0) return null;
        if (result.status === "ready") {
          const solution = result.solution as Record<string, unknown> | undefined;
          const token = solution?.gRecaptchaResponse ?? solution?.token;
          return typeof token === "string" ? token : null;
        }
        // status === "processing" → keep polling
      }
      return null;
    } catch {
      return null;
    }
  }

  private async post(path: string, body: unknown): Promise<Record<string, any>> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, any>;
  }
}
