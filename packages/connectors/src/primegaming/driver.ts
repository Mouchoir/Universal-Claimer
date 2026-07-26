import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

/** A Prime Gaming offer that can be claimed (title + absolute offer URL). */
export interface PrimeOffer {
  title: string;
  url: string;
}

/** Page-interaction surface the Prime Gaming connector needs; faked in contract tests. */
export interface PrimeGamingPageDriver {
  applyCookies(cookies: BrowserCookie[]): Promise<void>;
  isAuthenticated(): Promise<boolean>;
  /** Offers currently claimable with Prime (free games). */
  listClaimableGames(): Promise<PrimeOffer[]>;
  /** Claim one offer. */
  claimGame(offer: PrimeOffer): Promise<{ claimed: boolean; alreadyOwned?: boolean; captcha?: boolean }>;
  getUsername(): Promise<string | undefined>;
  getCookies(): Promise<BrowserCookie[]>;
  goto(url: string): Promise<void>;
}

export type PrimeGamingDriverFactory = (session: SessionHandle) => PrimeGamingPageDriver;

// Prime Gaming's home now redirects to Amazon Luna's claims page; both origins serve the same
// offer cards, so we follow whatever the entry point resolves to.
const HOME_URL = "https://gaming.amazon.com/home";
const BASE_ORIGIN = "https://gaming.amazon.com";

/**
 * Turn a card's raw text into the game title. Cards render as "<title>Claim game" (the CTA label
 * is a child of the same anchor), and the label is localized, so the title is taken from the
 * card's heading when present and the trailing CTA stripped as a fallback.
 */
export function cleanOfferTitle(rawTitle: string, cardText: string): string {
  const heading = rawTitle.trim();
  if (heading) return heading;
  // Fallback: drop a trailing CTA phrase ("Claim game", "Obtenir le jeu", …) from the card text.
  return cardText
    .trim()
    .replace(/\s*(claim|get|collect|obtenir|reclamar|einlösen)\b.*$/i, "")
    .trim();
}

/** Make an offer href absolute, whichever Amazon origin served the card. */
export function absoluteOfferUrl(href: string, origin = BASE_ORIGIN): string {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  return `${origin.replace(/\/$/, "")}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * Real Playwright-backed driver. Offer cards are located by Amazon's `data-a-target` attributes,
 * which stay in English whatever the account's display language — the same language-independent
 * approach used for Twitch. Amazon rejects hand-written GraphQL queries (403 on anything outside
 * its persisted set), so the offer list is read from the rendered page.
 */
export class PlaywrightPrimeGamingDriver implements PrimeGamingPageDriver {
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

  /**
   * Amazon marks a signed-in session with its `at-main` auth-token cookie (`sess-at-main` on some
   * marketplaces). Checking the cookie rather than page text keeps this independent of the
   * account's language.
   */
  async isAuthenticated(): Promise<boolean> {
    const cookies = await this.context.cookies(["https://www.amazon.com", "https://gaming.amazon.com"]);
    return cookies.some(
      (c) => (c.name === "at-main" || c.name === "sess-at-main" || c.name === "at-acbfr") && Boolean(c.value),
    );
  }

  async listClaimableGames(): Promise<PrimeOffer[]> {
    const page = await this.page();
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
    // The offer grid is rendered client-side; wait for the cards rather than a fixed delay.
    await page
      .waitForSelector("a[data-a-target='learn-more-card']", { timeout: 20_000 })
      .catch(() => undefined);

    const raw = await page
      .evaluate(() => {
        const out: { href: string; heading: string; text: string }[] = [];
        for (const a of Array.from(document.querySelectorAll("a[data-a-target='learn-more-card']"))) {
          // Only cards that actually offer a claim (free game with Prime).
          const claimable = a.querySelector("[data-a-target='FGWPOffer']") !== null;
          if (!claimable) continue;
          out.push({
            href: a.getAttribute("href") ?? "",
            heading: (a.querySelector("h3, [data-a-target*='title']")?.textContent ?? "").trim(),
            text: (a.textContent ?? "").trim(),
          });
        }
        return out;
      })
      .catch(() => [] as { href: string; heading: string; text: string }[]);

    const origin = new URL(page.url()).origin;
    const seen = new Set<string>();
    const offers: PrimeOffer[] = [];
    for (const r of raw) {
      const url = absoluteOfferUrl(r.href, origin);
      const title = cleanOfferTitle(r.heading, r.text);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      offers.push({ title, url });
    }
    return offers;
  }

  async claimGame(offer: PrimeOffer): Promise<{ claimed: boolean; alreadyOwned?: boolean; captcha?: boolean }> {
    const page = await this.page();
    await page.goto(offer.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500).catch(() => undefined);
    if (await this.detectCaptcha(page)) return { claimed: false, captcha: true };

    const cta = await this.claimButton(page);
    // No claim affordance at all: already in the library, or the offer ended.
    if (!cta) return { claimed: false, alreadyOwned: true };

    await cta.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(4000).catch(() => undefined);
    if (await this.detectCaptcha(page)) return { claimed: false, captcha: true };

    // Verify rather than assume: reload the offer and treat it as claimed only once the claim
    // affordance is gone (the same verify-don't-guess rule the Epic connector follows).
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForTimeout(2500).catch(() => undefined);
    const still = await this.claimButton(page);
    return still ? { claimed: false } : { claimed: true };
  }

  /** The offer page's claim control, by attribute first and visible label only as a fallback. */
  private async claimButton(page: Page) {
    for (const sel of [
      "[data-a-target='FGWPOffer']",
      "[data-a-target='buy-box_call-to-action']",
      "[data-a-target='cta-button']",
    ]) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) return loc;
    }
    const byText = page.getByRole("button", { name: /claim|get game|collect/i }).first();
    return (await byText.count().catch(() => 0)) > 0 ? byText : null;
  }

  async getUsername(): Promise<string | undefined> {
    const page = await this.page();
    try {
      const name = await page
        .locator("[data-a-target='user-dropdown-first-name-text'], [data-a-target='nav-line-1']")
        .first()
        .textContent()
        .catch(() => null);
      const trimmed = (name ?? "").replace(/^hello,?\s*/i, "").trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
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
    return (
      (await page
        .locator("iframe[src*='hcaptcha'], iframe[src*='recaptcha'], form[action*='validateCaptcha']")
        .count()
        .catch(() => 0)) > 0
    );
  }
}
