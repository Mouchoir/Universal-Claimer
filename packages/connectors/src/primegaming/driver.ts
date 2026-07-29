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
  /** Host Prime Gaming served for this region (it routes by marketplace). */
  servedHost(): Promise<string>;
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

/**
 * Does this cookie mark a signed-in Amazon session? The auth-token cookie is `at-main` on
 * amazon.com but `at-acb<country>` on the other marketplaces (`at-acbfr` for amazon.fr,
 * `at-acbde` for amazon.de …), and `sess-at-*` is its session-scoped twin — so matching by
 * pattern, on any Amazon domain, is what makes this work for accounts worldwide.
 */
export function isAmazonAuthCookie(name: string, domain: string): boolean {
  if (!/(^|\.)amazon\./i.test(domain)) return false;
  return /^(sess-)?at-(main|acb[a-z]{2})$/i.test(name);
}

/**
 * Which store an offer is redeemed on, derived from the slug suffix Amazon puts on every claim
 * URL (`framed-collection-gog`, `lonestar-epic`, `terraforming-mars-aga`). That suffix is part of
 * the URL rather than the rendered page, so it is immune to the display language. Unknown
 * suffixes return undefined rather than a guess.
 */
const PLATFORM_BY_SUFFIX: Record<string, string> = {
  gog: "GOG",
  epic: "Epic Games Store",
  aga: "Amazon Games App",
  legacy: "Legacy Games",
  microsoft: "Microsoft Store",
  origin: "EA app",
  ubisoft: "Ubisoft Connect",
};

export function platformFromOfferUrl(url: string): string | undefined {
  const m = /\/claims\/([^/]+)\//.exec(url) ?? /\/([^/]+)\/dp\//.exec(url);
  const slug = m?.[1];
  if (!slug) return undefined;
  const suffix = slug.split("-").pop() ?? "";
  return PLATFORM_BY_SUFFIX[suffix.toLowerCase()];
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
   * Ask the page it will actually claim on, rather than inferring from cookies.
   *
   * Cookie sniffing gave false positives: Amazon signs you in per marketplace, and Prime Gaming
   * routes by region — an account holding a valid `at-main` on amazon.com still lands signed-out
   * on luna.amazon.fr. The claim then failed with no useful explanation. A signed-out page
   * exposes `data-a-target="sign-in-button"`; that attribute is English whatever the display
   * language, so this stays locale-independent while being true to what the claim will face.
   */
  async isAuthenticated(): Promise<boolean> {
    const page = await this.page();
    if (!/amazon\./i.test(page.url())) {
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000).catch(() => undefined);
    }
    const signedOut = await page
      .locator("[data-a-target='sign-in-button']")
      .count()
      .catch(() => 0);
    return signedOut === 0;
  }

  /** The host Prime Gaming actually served (it routes by region), for a precise error message. */
  async servedHost(): Promise<string> {
    const page = await this.page();
    try {
      return new URL(page.url()).host;
    } catch {
      return "gaming.amazon.com";
    }
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

  /**
   * The offer page's claim control. `buy-box_call-to-action` is the real one; `FGWPOffer` is
   * deliberately NOT used here — on an offer page those belong to the "more offers" carousel at
   * the bottom, so matching them navigated to a different game instead of claiming this one.
   */
  private async claimButton(page: Page) {
    for (const sel of [
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
