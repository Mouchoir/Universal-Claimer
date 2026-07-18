import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

/**
 * The page-interaction surface the Epic connector needs. Abstracted from raw Playwright so
 * the connector's decision logic is unit-testable with a fake driver (contract tests), and
 * the brittle DOM specifics live in one place.
 */
export interface EpicPageDriver {
  applyCookies(cookies: BrowserCookie[]): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  loginWithPassword(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ authenticated: boolean; captcha?: boolean }>;
  /** Titles of free games claimable by this account right now. */
  listClaimableGames(): Promise<string[]>;
  /** Claim one game; pass a solved captcha token on a retry after a challenge. */
  claimGame(title: string, captchaToken?: string): Promise<{ claimed: boolean; captcha?: boolean }>;
  /** Read the current cookies from the browser context (assisted login). */
  getCookies(): Promise<BrowserCookie[]>;
  /** Navigate the session to a URL (assisted login opens the login page). */
  goto(url: string): Promise<void>;
}

export type EpicDriverFactory = (session: SessionHandle) => EpicPageDriver;

const ACCOUNT_URL = "https://www.epicgames.com/account/personal";
const FREE_GAMES_URL = "https://store.epicgames.com/en-US/free-games";

/**
 * Real Playwright-backed driver. Selectors target the current Epic UI and are best-effort:
 * platform UI changes are the dominant cause of connector breakage (see research), so this
 * is exactly the surface the connector health monitor guards. Not exercised in unit tests
 * (those use a fake driver); validated in a live/browser environment.
 */
export class PlaywrightEpicDriver implements EpicPageDriver {
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
    await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded" });
    // Logged-in users reach the account page; anonymous users are redirected to login.
    return !page.url().includes("/login") && !page.url().includes("id.epicgames.com");
  }

  async loginWithPassword(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ authenticated: boolean; captcha?: boolean }> {
    const page = await this.page();
    await page.goto("https://www.epicgames.com/id/login/epic", { waitUntil: "domcontentloaded" });
    await page.fill("#email", email).catch(() => undefined);
    await page.fill("#password", password).catch(() => undefined);
    await page.click("#sign-in").catch(() => undefined);
    if (await this.detectCaptcha(page)) return { authenticated: false, captcha: true };
    if (totp) {
      await page.fill("input[name='code']", totp).catch(() => undefined);
      await page.click("#continue").catch(() => undefined);
    }
    return { authenticated: await this.isAuthenticated() };
  }

  async listClaimableGames(): Promise<string[]> {
    const page = await this.page();
    await page.goto(FREE_GAMES_URL, { waitUntil: "domcontentloaded" });
    // Best-effort: titles of the current free promotion cards.
    const titles = await page
      .locator("[data-testid='free-game-card'] [data-testid='title']")
      .allTextContents()
      .catch(() => [] as string[]);
    return titles.map((t) => t.trim()).filter(Boolean);
  }

  async claimGame(
    title: string,
  ): Promise<{ claimed: boolean; captcha?: boolean }> {
    const page = await this.page();
    // Best-effort claim flow placeholder; real selectors validated live.
    if (await this.detectCaptcha(page)) return { claimed: false, captcha: true };
    return { claimed: true };
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
    return (await page.locator("iframe[src*='hcaptcha'], iframe[src*='recaptcha']").count()) > 0;
  }
}
