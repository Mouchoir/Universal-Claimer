import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

/** A Prime Gaming offer that can be claimed (title + absolute offer URL). */
export interface PrimeOffer {
  title: string;
  url: string;
}

/** One page the sign-in check looked at. Hosts only: this is logged and shown to the operator. */
export interface SignInAttempt {
  /** Host the check asked for: the gaming.amazon.com entry point, or a marketplace's Luna host. */
  requested: string;
  /** Host the page ended on after Amazon's redirects; empty when the navigation itself failed. */
  served: string;
  signedIn: boolean;
  /** Why the navigation failed (the host does not resolve, it timed out), when it did. */
  navError?: string;
}

/** What the last sign-in check saw, so a failure can say exactly where the session was refused. */
export interface AuthReport {
  /** Marketplaces the imported session holds a live Amazon sign-in for, freshest first. */
  marketplaces: string[];
  /** Every page the check looked at, in order. */
  attempts: SignInAttempt[];
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
  /** Marketplaces the session is signed in on and the hosts the last isAuthenticated() tried. */
  authReport(): Promise<AuthReport>;
  getCookies(): Promise<BrowserCookie[]>;
  goto(url: string): Promise<void>;
}

export type PrimeGamingDriverFactory = (session: SessionHandle) => PrimeGamingPageDriver;

// Prime Gaming's home now redirects to Amazon Luna's claims page; both origins serve the same
// offer cards. Where it redirects depends on the identity it sees, and gaming.amazon.com only
// sees .amazon.com cookies: a jar signed in on amazon.com is sent to that account's own Luna
// host (luna.amazon.fr for a French account), while a jar signed in only on amazon.fr looks
// anonymous there and is sent to luna.amazon.com, signed out. That is why the sign-in check
// falls back to the Luna host of each marketplace the session is actually signed in on.
const HOME_URL = "https://gaming.amazon.com/home";
const BASE_ORIGIN = "https://gaming.amazon.com";
const CLAIMS_HOME_PATH = "/claims/home";

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
 * The Amazon marketplace a cookie domain belongs to: `.amazon.fr` is `amazon.fr`,
 * `luna.amazon.co.uk` is `amazon.co.uk`, `www.amazon.com.be` is `amazon.com.be`. It is read off
 * the shape of the domain rather than a region table, so a marketplace Amazon opens later works
 * without a code change. What follows `amazon` must look like a public suffix (one or two short
 * alphabetic labels: `fr`, `com`, `co.jp`, `com.au`), which keeps `amazon.example.org` out.
 * Returns null for anything that is not an Amazon marketplace.
 */
export function amazonMarketplace(domain: string): string | null {
  const labels = domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "").split(".");
  const at = labels.lastIndexOf("amazon");
  if (at < 0) return null;
  const suffix = labels.slice(at + 1);
  if (suffix.length < 1 || suffix.length > 2) return null;
  if (!suffix.every((label) => /^[a-z]{2,3}$/.test(label))) return null;
  return ["amazon", ...suffix].join(".");
}

/**
 * The marketplaces a session is signed in on: those holding a non-empty, unexpired auth cookie
 * (see isAmazonAuthCookie), freshest expiry first, so the sign-in the operator renewed most
 * recently is the first one tried. A session cookie (no expiry) lives as long as the browser that
 * set it, which is as fresh as a cookie gets. `now` is epoch milliseconds; cookie expiries are
 * Unix seconds, as both Playwright and cookies.txt write them (Playwright uses -1 for "session").
 */
export function signedInMarketplaces(cookies: readonly BrowserCookie[], now: number = Date.now()): string[] {
  const freshest = new Map<string, number>();
  for (const c of cookies) {
    if (!c.value.trim() || !isAmazonAuthCookie(c.name, c.domain)) continue;
    const marketplace = amazonMarketplace(c.domain);
    if (!marketplace) continue;
    const isSession = c.expires === undefined || c.expires <= 0;
    const expiry = isSession ? Number.POSITIVE_INFINITY : (c.expires as number);
    // An expired auth cookie is what a lapsed sign-in leaves behind; it proves nothing.
    if (!isSession && expiry * 1000 <= now) continue;
    freshest.set(marketplace, Math.max(freshest.get(marketplace) ?? Number.NEGATIVE_INFINITY, expiry));
  }
  return [...freshest.entries()]
    .sort((a, b) => (a[1] === b[1] ? 0 : b[1] > a[1] ? 1 : -1))
    .map(([marketplace]) => marketplace);
}

/** Luna's claims page for a marketplace: `amazon.fr` is https://luna.amazon.fr/claims/home. */
export function lunaClaimsHome(marketplace: string): string {
  return `https://luna.${marketplace}${CLAIMS_HOME_PATH}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** A Luna host of some Amazon marketplace (luna.amazon.fr, luna.amazon.co.uk, ...). */
export function isLunaHost(host: string): boolean {
  return /^luna\./i.test(host) && amazonMarketplace(host) !== null;
}

/** The first line of a navigation error: Playwright appends a multi-line call log to it. */
function navErrorOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n")[0] ?? "").trim().slice(0, 200) || "navigation failed";
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
  /** The imported cookies: the marketplaces they are signed in on decide where to look. */
  private appliedCookies: BrowserCookie[] = [];
  /** Claims page of the host the sign-in check found signed in; listing must happen there. */
  private claimsHome: string | undefined;
  private report: AuthReport = { marketplaces: [], attempts: [] };

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
    // Every cookie is applied as it came, including marketplaces with no auth cookie: Amazon
    // may well need them. The copy is kept only to know which marketplaces to try.
    this.appliedCookies = [...this.appliedCookies, ...cookies];
  }

  /**
   * Find a Luna page that has this session signed in, and remember it as where to list offers.
   *
   * The verdict always comes from a page, never from cookies alone: a cookie can look valid and
   * still be refused. A signed-out page exposes `data-a-target="sign-in-button"`; that attribute
   * is English whatever the display language, so this stays locale-independent.
   *
   * The first step is the check this connector has always made: the gaming.amazon.com entry
   * point, which works for any jar Amazon can identify from its .amazon.com cookies. Only when
   * that page is signed out does it go further, because gaming.amazon.com cannot see a sign-in
   * held on another marketplace: a French account signed in only on amazon.fr is routed there
   * as an anonymous visitor to luna.amazon.com. Each marketplace the imported cookies are signed
   * in on is then tried on its own Luna host, freshest sign-in first. Some marketplaces have no
   * Luna host at all (luna.amazon.co.jp does not resolve), so a failed navigation moves on to the
   * next one instead of ending the run.
   */
  async isAuthenticated(): Promise<boolean> {
    const page = await this.page();
    const attempts: SignInAttempt[] = [];
    this.claimsHome = undefined;
    this.report = { marketplaces: signedInMarketplaces(this.appliedCookies), attempts };

    let requested = hostOf(page.url());
    if (!/amazon\./i.test(page.url())) {
      requested = hostOf(HOME_URL);
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000).catch(() => undefined);
    }
    const entry: SignInAttempt = {
      requested,
      served: hostOf(page.url()),
      signedIn: await this.showsSignedIn(page),
    };
    attempts.push(entry);
    if (entry.signedIn) {
      // Only a Luna host has a /claims/home. Anything else (the redirect has not happened yet)
      // keeps listing through the entry point, exactly as before.
      if (isLunaHost(entry.served)) this.claimsHome = new URL(CLAIMS_HOME_PATH, page.url()).href;
      return true;
    }

    for (const marketplace of this.report.marketplaces) {
      const url = lunaClaimsHome(marketplace);
      const host = hostOf(url);
      if (attempts.some((a) => a.served === host || a.requested === host)) continue;
      const attempt = await this.tryLunaHost(page, url);
      attempts.push(attempt);
      if (attempt.signedIn) {
        this.claimsHome = new URL(CLAIMS_HOME_PATH, page.url()).href;
        return true;
      }
    }
    return false;
  }

  /** One fallback probe: open a marketplace's Luna claims page and read what it shows. */
  private async tryLunaHost(page: Page, url: string): Promise<SignInAttempt> {
    const requested = hostOf(url);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (err) {
      return { requested, served: "", signedIn: false, navError: navErrorOf(err) };
    }
    await page.waitForTimeout(4000).catch(() => undefined);
    const served = hostOf(page.url());
    // The check reads the absence of a sign-in button, so it only means something on a Luna
    // page: Amazon's own sign-in form has no such button and would read as signed in.
    const signedIn = isLunaHost(served) && (await this.showsSignedIn(page));
    return { requested, served, signedIn };
  }

  private async showsSignedIn(page: Page): Promise<boolean> {
    const signedOut = await page
      .locator("[data-a-target='sign-in-button']")
      .count()
      .catch(() => 0);
    return signedOut === 0;
  }

  /** What the last sign-in check saw, for a failure message that names the right host. */
  async authReport(): Promise<AuthReport> {
    return {
      marketplaces: [...this.report.marketplaces],
      attempts: this.report.attempts.map((a) => ({ ...a })),
    };
  }

  async listClaimableGames(): Promise<PrimeOffer[]> {
    const page = await this.page();
    // List on the host the sign-in check found signed in. Anonymous luna.amazon.com still renders
    // every claim card, so listing anywhere else would turn a sign-in problem into a run of
    // claims that each fail for no visible reason.
    await page.goto(this.claimsHome ?? HOME_URL, { waitUntil: "domcontentloaded" });
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
