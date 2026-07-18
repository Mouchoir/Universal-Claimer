import { describe, expect, it, vi } from "vitest";
import { AntiCaptchaSolver, NullCaptchaSolver, type CaptchaTask } from "./captcha.js";

const task: CaptchaTask = {
  type: "recaptcha_v2",
  websiteURL: "https://store.epicgames.com",
  websiteKey: "site-key",
};

describe("NullCaptchaSolver", () => {
  it("always returns null (defers to human action)", async () => {
    expect(await new NullCaptchaSolver().solve()).toBeNull();
  });
});

describe("AntiCaptchaSolver", () => {
  const jsonResponse = (body: unknown): Response =>
    ({ json: async () => body }) as unknown as Response;

  it("creates a task and returns the solution token once ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ errorId: 0, taskId: 42 }))
      .mockResolvedValueOnce(jsonResponse({ errorId: 0, status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "TOKEN" } }),
      );
    const solver = new AntiCaptchaSolver({
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
      pollIntervalMs: 1,
    });
    expect(await solver.solve(task)).toBe("TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns null when task creation errors", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ errorId: 1, errorCode: "ERROR_KEY_DOES_NOT_EXIST" }));
    const solver = new AntiCaptchaSolver({ apiKey: "bad", fetchImpl, sleep: async () => {} });
    expect(await solver.solve(task)).toBeNull();
  });

  it("returns null (not throw) when fetch rejects", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));
    const solver = new AntiCaptchaSolver({ apiKey: "k", fetchImpl, sleep: async () => {} });
    expect(await solver.solve(task)).toBeNull();
  });
});
