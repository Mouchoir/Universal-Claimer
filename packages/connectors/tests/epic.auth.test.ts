import { describe, expect, it, vi } from "vitest";
import { NullCaptchaSolver, createLogger } from "@uc/core";
import { EpicConnector } from "../src/epic/index.js";
import type { EpicPageDriver, EpicSignInCheck } from "../src/epic/driver.js";
import type { BrowserFactory, ConnectorContext, SessionHandle } from "../src/connector.js";

const SIGNED_IN: EpicSignInCheck = { state: "signed_in", path: "/account/personal", status: 200, bounced: false };
const SIGNED_OUT: EpicSignInCheck = { state: "signed_out", path: "/id/login", status: 200, bounced: false };

/** A session handle whose context is never touched by the fake driver. */
const fakeSession = { context: {} } as unknown as SessionHandle;

const fakeBrowser: BrowserFactory = {
  launch: async () => fakeSession,
  close: async () => {},
};

function makeCtx(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    browser: fakeBrowser,
    captcha: new NullCaptchaSolver(),
    totp: () => "123456",
    emit: () => {},
    log: createLogger({ sink: () => {} }),
    ...overrides,
  };
}

/** Fake driver programmed per fixture. */
function fakeDriver(overrides: Partial<EpicPageDriver>): EpicPageDriver {
  return {
    applyCookies: async () => {},
    checkSignIn: async () => SIGNED_IN,
    loginWithPassword: async () => ({ check: SIGNED_IN }),
    listClaimableGames: async () => [],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "ExampleUser",
    getCookies: async () => [],
    goto: async () => {},
    ...overrides,
  };
}

describe("EpicConnector.authenticate", () => {
  it("session import with a valid session → ok", async () => {
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ checkSignIn: async () => SIGNED_IN }),
    });
    const res = await connector.authenticate(
      { method: "session_import", cookies: [] },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.fingerprint.userAgent).toContain("Chrome");
  });

  it("session import with an expired session → not ok, with a reason", async () => {
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ checkSignIn: async () => SIGNED_OUT }),
    });
    const res = await connector.authenticate(
      { method: "session_import", cookies: [] },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/expired|not authenticated/i);
  });

  it("credential login uses the TOTP from context and reports success", async () => {
    const totp = vi.fn(() => "654321");
    const loginWithPassword = vi.fn(async () => ({ check: SIGNED_IN }));
    const connector = new EpicConnector({ createDriver: () => fakeDriver({ loginWithPassword }) });
    const res = await connector.authenticate(
      { method: "credential_totp", email: "a@b.com", password: "pw", totpSeed: "SEED" },
      makeCtx({ totp }),
    );
    expect(res.ok).toBe(true);
    expect(totp).toHaveBeenCalledWith("SEED");
    expect(loginWithPassword).toHaveBeenCalledWith("a@b.com", "pw", "654321");
  });

  it("a captcha during login → not ok, guiding the user to session import", async () => {
    const connector = new EpicConnector({
      createDriver: () => fakeDriver({ loginWithPassword: async () => ({ captcha: true }) }),
    });
    const res = await connector.authenticate(
      { method: "credential_totp", email: "a@b.com", password: "pw" },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/captcha/i);
  });

  it("closes the browser session even on the happy path", async () => {
    const close = vi.fn(async () => {});
    const connector = new EpicConnector({ createDriver: () => fakeDriver({}) });
    await connector.authenticate({ method: "session_import", cookies: [] }, makeCtx({
      browser: { launch: async () => fakeSession, close },
    }));
    expect(close).toHaveBeenCalledOnce();
  });
});
