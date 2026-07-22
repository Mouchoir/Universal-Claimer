import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

/** A currently-free Epic game (title + absolute product URL). */
export interface FreeGame {
  title: string;
  url: string;
}

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
  /** Free games claimable right now (title + product URL). */
  listClaimableGames(): Promise<FreeGame[]>;
  /** Claim one game. Pass a solved captcha token on a retry after a challenge. */
  claimGame(
    game: FreeGame,
    captchaToken?: string,
  ): Promise<{ claimed: boolean; captcha?: boolean; alreadyOwned?: boolean }>;
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

  async listClaimableGames(): Promise<FreeGame[]> {
    const page = await this.page();
    await page.goto(FREE_GAMES_URL, { waitUntil: "domcontentloaded" });
    // Give the free-games grid a moment to render.
    await page.waitForTimeout(1500).catch(() => undefined);
    // Free-now games are anchors whose aria-label contains "Free Now"; the title sits
    // between the second "Free Now," and ", Free Now -" (validated against the live page).
    const games = await page
      .evaluate(() => {
        const seen = new Set<string>();
        const out: { title: string; url: string }[] = [];
        for (const a of Array.from(document.querySelectorAll("a[aria-label]"))) {
          const label = a.getAttribute("aria-label") ?? "";
          if (!/Free Now/i.test(label)) continue;
          const href = a.getAttribute("href") ?? "";
          if (!href.includes("/p/")) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          const m = label.match(/Free Now,\s*(.+?),\s*Free Now\s*-/i);
          out.push({ title: (m?.[1] ?? a.textContent ?? "").trim(), url: href });
        }
        return out;
      })
      .catch(() => [] as { title: string; url: string }[]);
    return games.map((g) => ({
      title: g.title,
      url: g.url.startsWith("http") ? g.url : `https://store.epicgames.com${g.url}`,
    }));
  }

  async claimGame(
    game: FreeGame,
  ): Promise<{ claimed: boolean; captcha?: boolean; alreadyOwned?: boolean }> {
    const page = await this.page();
    await page.goto(game.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200).catch(() => undefined);
    if (await this.detectCaptcha(page)) return { claimed: false, captcha: true };

    // The purchase CTA (stable testid). Its label tells us if the game is already owned.
    const cta = page.locator("[data-testid='purchase-cta-button']").first();
    if ((await cta.count().catch(() => 0)) === 0) return { claimed: false, alreadyOwned: true };
    const ctaText = ((await cta.textContent().catch(() => "")) ?? "").toLowerCase();
    if (/in library|owned|biblioth|dans la biblioth|installer|install/i.test(ctaText)) {
      return { claimed: false, alreadyOwned: true };
    }

    await cta.click().catch(() => undefined);
    // The purchase overlay (iframe) loads. Best-effort: place the order and accept any EULA,
    // searching the main page + all frames. This checkout flow is the part most likely to
    // need live tuning per Epic UI changes.
    await page.waitForTimeout(2500).catch(() => undefined);
    if (await this.detectCaptcha(page)) return { claimed: false, captcha: true };

    const clickInAnyFrame = async (re: RegExp): Promise<void> => {
      for (const frame of page.frames()) {
        const btn = frame.getByRole("button", { name: re }).first();
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 6000 }).catch(() => undefined);
          return;
        }
      }
    };
    await clickInAnyFrame(/place order|passer la commande/i);
    await clickInAnyFrame(/i agree|j['’]accepte|accept/i);
    await page.waitForTimeout(2500).catch(() => undefined);
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
