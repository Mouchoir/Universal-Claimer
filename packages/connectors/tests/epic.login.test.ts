import { describe, expect, it } from "vitest";
import { NullCaptchaSolver, createLogger } from "@uc/core";
import { EpicConnector } from "../src/epic/index.js";
import { supportsInteractiveLogin } from "../src/connector.js";
import type { EpicPageDriver, EpicSignInCheck } from "../src/epic/driver.js";
import type { ConnectorContext, SessionHandle } from "../src/connector.js";

const SIGNED_IN: EpicSignInCheck = { state: "signed_in", path: "/account/personal", status: 200, bounced: false };
const SIGNED_OUT: EpicSignInCheck = { state: "signed_out", path: "/id/login", status: 200, bounced: false };

const fakeSession = { context: {} } as unknown as SessionHandle;
const ctx: ConnectorContext = {
  browser: { launch: async () => fakeSession, close: async () => {} },
  captcha: new NullCaptchaSolver(),
  totp: () => "000000",
  emit: () => {},
  log: createLogger({ sink: () => {} }),
};

function fakeDriver(over: Partial<EpicPageDriver>): EpicPageDriver {
  return {
    applyCookies: async () => {},
    checkSignIn: async () => SIGNED_IN,
    loginWithPassword: async () => ({ authenticated: true }),
    listClaimableGames: async () => [],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "ExampleUser",
    getCookies: async () => [],
    goto: async () => {},
    ...over,
  };
}

describe("EpicConnector interactive login", () => {
  it("advertises the capability and a login URL", () => {
    const connector = new EpicConnector();
    expect(supportsInteractiveLogin(connector)).toBe(true);
    expect(connector.loginUrl).toMatch(/^https:\/\/.*epicgames\.com/);
  });

  it("isLoggedIn reflects the driver auth state", async () => {
    const yes = new EpicConnector({ createDriver: () => fakeDriver({ checkSignIn: async () => SIGNED_IN }) });
    const no = new EpicConnector({ createDriver: () => fakeDriver({ checkSignIn: async () => SIGNED_OUT }) });
    expect(await yes.isLoggedIn(fakeSession, ctx)).toBe(true);
    expect(await no.isLoggedIn(fakeSession, ctx)).toBe(false);
  });

  it("extractCookies returns the browser cookies", async () => {
    const connector = new EpicConnector({
      createDriver: () =>
        fakeDriver({
          getCookies: async () => [
            { name: "EPIC_SSO", value: "abc", domain: ".epicgames.com", path: "/", httpOnly: true },
          ],
        }),
    });
    const cookies = await connector.extractCookies(fakeSession);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: "EPIC_SSO", httpOnly: true });
  });
});
