import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

/** Page-interaction surface the Microsoft Rewards connector needs; faked in contract tests. */
export interface MsRewardsPageDriver {
  applyCookies(cookies: BrowserCookie[]): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  loginWithPassword(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ authenticated: boolean; captcha?: boolean }>;
  /** How many desktop searches are still needed to complete today's set. */
  remainingSearches(): Promise<number>;
  /** Perform one Bing search. */
  search(query: string): Promise<{ ok: boolean; captcha?: boolean }>;
  getCookies(): Promise<BrowserCookie[]>;
  goto(url: string): Promise<void>;
}

export type MsRewardsDriverFactory = (session: SessionHandle) => MsRewardsPageDriver;

const REWARDS_URL = "https://rewards.bing.com/";
const BING_SEARCH = "https://www.bing.com/search?q=";

/**
 * Real Playwright-backed driver. Targets the current (modern) Bing Rewards dashboard; the
 * legacy dashboard is not supported. Selectors are best-effort and validated live.
 */
export class PlaywrightMsRewardsDriver implements MsRewardsPageDriver {
  private readonly context: BrowserContext;
  constructor(session: SessionHandle) {
    this.context = session.context;
  }

  private async page(): Promise<Page> {
    const pages = this.context.pages();
    return pages[0] ?? (await this.context.newPage());
  }

  async applyCookies(cookies: BrowserCookie[]): Promise<void> {
    await this.context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        ...(c.expires !== undefined ? { expires: c.expires } : {}),
        ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
        ...(c.secure !== undefined ? { secure: c.secure } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      })),
    );
  }

  async isAuthenticated(): Promise<boolean> {
    const page = await this.page();
    await page.goto(REWARDS_URL, { waitUntil: "domcontentloaded" });
    return !page.url().includes("login.live.com") && !page.url().includes("/signin");
  }

  async loginWithPassword(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ authenticated: boolean; captcha?: boolean }> {
    const page = await this.page();
    // Microsoft's sign-in renders in the account/browser language, so drive it by stable input
    // ids and submit buttons instead of visible labels ("Next"/"Sign in" differ per locale).
    // This keeps the connector working for users in any language.
    await page.goto("https://login.live.com/", { waitUntil: "domcontentloaded" });
    await page.fill("input[type='email']", email).catch(() => undefined);
    await page.click("input[type='submit'], #idSIButton9").catch(() => undefined);
    await page.fill("input[type='password']", password).catch(() => undefined);
    await page.click("input[type='submit'], #idSIButton9").catch(() => undefined);
    if (await this.detectCaptcha(page)) return { authenticated: false, captcha: true };
    if (totp) {
      await page.fill("input[name='otc']", totp).catch(() => undefined);
      await page.click("input[type='submit'], #idSubmit_SAOTCC_Continue").catch(() => undefined);
    }
    return { authenticated: await this.isAuthenticated() };
  }

  async remainingSearches(): Promise<number> {
    const page = await this.page();
    await page.goto(REWARDS_URL, { waitUntil: "domcontentloaded" });
    // Best-effort: read the desktop-search progress ("x of y"). Fall back to a default set.
    const text = await page
      .locator("[data-testid='search-card'], .pointsDetail")
      .first()
      .textContent()
      .catch(() => null);
    const m = text?.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return Math.max(0, Number(m[2]) - Number(m[1]));
    return 30; // default desktop allowance if progress can't be read
  }

  async search(query: string): Promise<{ ok: boolean; captcha?: boolean }> {
    const page = await this.page();
    await page.goto(BING_SEARCH + encodeURIComponent(query), { waitUntil: "domcontentloaded" });
    if (await this.detectCaptcha(page)) return { ok: false, captcha: true };
    return { ok: true };
  }

  async getCookies(): Promise<BrowserCookie[]> {
    const cookies = await this.context.cookies();
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
  }

  async goto(url: string): Promise<void> {
    const page = await this.page();
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  private async detectCaptcha(page: Page): Promise<boolean> {
    return (await page.locator("iframe[src*='hcaptcha'], iframe[src*='captcha']").count()) > 0;
  }
}
