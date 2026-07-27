import { describe, expect, it } from "vitest";
import { NullCaptchaSolver, createLogger } from "@uc/core";
import { EpicConnector } from "../src/epic/index.js";
import { supportsInteractiveLogin } from "../src/connector.js";
import type { EpicPageDriver } from "../src/epic/driver.js";
import type { ConnectorContext, SessionHandle } from "../src/connector.js";

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
    isAuthenticated: async () => true,
    loginWithPassword: async () => ({ authenticated: true }),
    listClaimableGames: async () => [],
    claimGame: async () => ({ claimed: true }),
    getUsername: async () => "EmptyProfile",
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
    const yes = new EpicConnector({ createDriver: () => fakeDriver({ isAuthenticated: async () => true }) });
    const no = new EpicConnector({ createDriver: () => fakeDriver({ isAuthenticated: async () => false }) });
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
