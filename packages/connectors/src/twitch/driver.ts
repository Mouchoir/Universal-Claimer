import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

export interface ResubResult {
  subscribed: boolean;
  alreadyActive?: boolean;
  captcha?: boolean;
  notFound?: boolean;
}

/** Page-interaction surface the Twitch connector needs; faked in contract tests. */
export interface TwitchPageDriver {
  applyCookies(cookies: BrowserCookie[]): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  loginWithPassword(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ authenticated: boolean; captcha?: boolean }>;
  /** Resubscribe to a channel using Twitch Prime. */
  resubWithPrime(channel: string): Promise<ResubResult>;
  getCookies(): Promise<BrowserCookie[]>;
  goto(url: string): Promise<void>;
}

export type TwitchDriverFactory = (session: SessionHandle) => TwitchPageDriver;

/**
 * Real Playwright-backed Twitch driver. Selectors target the current Twitch UI and are
 * best-effort (platform UI changes are the dominant cause of breakage; the connector health
 * monitor guards this). Not exercised in unit tests (those use a fake driver).
 */
export class PlaywrightTwitchDriver implements TwitchPageDriver {
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
    // Language-independent: Twitch sets an `auth-token` cookie for logged-in sessions. The old
    // check looked for an English "Log In" button, which is absent on a localized (e.g. French)
    // UI and made a logged-out session look authenticated.
    const cookies = await this.context.cookies("https://www.twitch.tv");
    return cookies.some((c) => c.name === "auth-token" && Boolean(c.value));
  }

  async loginWithPassword(
    email: string,
    password: string,
    totp?: string,
  ): Promise<{ authenticated: boolean; captcha?: boolean }> {
    const page = await this.page();
    await page.goto("https://www.twitch.tv/login", { waitUntil: "domcontentloaded" });
    await page.fill("#login-username", email).catch(() => undefined);
    await page.fill("#password-input", password).catch(() => undefined);
    await page.getByRole("button", { name: /log in/i }).click().catch(() => undefined);
    if (await this.detectCaptcha(page)) return { authenticated: false, captcha: true };
    if (totp) {
      await page.fill("input[autocomplete='one-time-code']", totp).catch(() => undefined);
      await page.getByRole("button", { name: /submit|verify/i }).click().catch(() => undefined);
    }
    return { authenticated: await this.isAuthenticated() };
  }

  async resubWithPrime(channel: string): Promise<ResubResult> {
    const page = await this.page();
    const resp = await page.goto(`https://www.twitch.tv/${encodeURIComponent(channel)}`, {
      waitUntil: "domcontentloaded",
    });
    if (resp && resp.status() === 404) return { subscribed: false, notFound: true };

    if (await this.detectCaptcha(page)) return { subscribed: false, captcha: true };

    // Labels are matched in English + French (the account UI locale). The subscribe button also
    // carries the stable data-a-target="subscribe-button" attribute, tried first.
    // If already subscribed, Twitch shows "Subscribed" / "Abonné" instead of a Subscribe button.
    const already = await page.getByText(/^(Subscribed|Abonné·?e?)$/i).count().catch(() => 0);
    if (already > 0) return { subscribed: false, alreadyActive: true };

    // Open the subscribe dialog, choose Prime, confirm. Best-effort (needs live validation on a
    // connected account — the subscribe UI only renders when logged in).
    let subBtn = page.locator("button[data-a-target='subscribe-button']").first();
    if ((await subBtn.count().catch(() => 0)) === 0) {
      subBtn = page.getByRole("button", { name: /^(Subscribe|Resubscribe|S['’]abonner|Se réabonner)$/i }).first();
    }
    if ((await subBtn.count().catch(() => 0)) === 0) {
      return { subscribed: false, alreadyActive: true }; // no subscribe affordance → nothing to do
    }
    await subBtn.click().catch(() => undefined);
    await page.getByText(/Use (your )?Prime|Utiliser (votre )?Prime/i).first().click().catch(() => undefined);
    if (await this.detectCaptcha(page)) return { subscribed: false, captcha: true };
    await page
      .getByRole("button", { name: /Subscribe with Prime|S['’]abonner avec Prime/i })
      .first()
      .click()
      .catch(() => undefined);

    // Verify: after subscribing, Twitch shows a subscribed state. Only report success if seen.
    await page.waitForTimeout(2500).catch(() => undefined);
    const nowSubbed = await page.getByText(/^(Subscribed|Abonné·?e?)$/i).count().catch(() => 0);
    return { subscribed: nowSubbed > 0 };
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
