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
// Epic's public free-games promotions feed — the source of truth for what is free right now,
// independent of the store UI's language and lazy-loaded rendering (the DOM-scraping approach
// broke when the logged-in store rendered in the account's locale). Same feed the reference
// project epicgames-freegames-node relies on.
const PROMOTIONS_URL = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
// Force the en-US store locale (the `/en-US/` path segment) so the checkout UI renders in English
// for *every* account regardless of its language preference. That lets the selectors below stay
// language-agnostic — the connector works for users worldwide, not only English/French ones.
const STORE_PRODUCT_BASE = "https://store.epicgames.com/en-US/p/";

/** Shape of the fields we read from the promotions feed (everything else is ignored). */
interface PromoElement {
  title?: string;
  productSlug?: string | null;
  urlSlug?: string | null;
  offerMappings?: { pageSlug?: string; pageType?: string }[] | null;
  catalogNs?: { mappings?: { pageSlug?: string; pageType?: string }[] | null } | null;
  promotions?: {
    promotionalOffers?: {
      promotionalOffers?: {
        startDate?: string;
        endDate?: string;
        discountSetting?: { discountPercentage?: number | string };
      }[];
    }[];
  } | null;
}

function productHomeSlug(mappings?: { pageSlug?: string; pageType?: string }[] | null): string | undefined {
  if (!mappings || mappings.length === 0) return undefined;
  return (mappings.find((m) => m.pageType === "productHome") ?? mappings[0])?.pageSlug;
}

/**
 * Parse the promotions feed into the games that are free *right now* (a promotional offer whose
 * window contains `now` and whose remaining price percentage is 0). Pure + unit-tested; the
 * driver only supplies the fetched JSON and the clock.
 */
export function parseFreeGamesResponse(json: unknown, now: number): FreeGame[] {
  const elements =
    (json as { data?: { Catalog?: { searchStore?: { elements?: PromoElement[] } } } })?.data
      ?.Catalog?.searchStore?.elements ?? [];
  const out: FreeGame[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    const groups = e.promotions?.promotionalOffers ?? [];
    const freeNow = groups.some((g) =>
      (g.promotionalOffers ?? []).some((o) => {
        const start = o.startDate ? Date.parse(o.startDate) : NaN;
        const end = o.endDate ? Date.parse(o.endDate) : NaN;
        const pct = Number(o.discountSetting?.discountPercentage);
        return Number.isFinite(start) && Number.isFinite(end) && start <= now && now <= end && pct === 0;
      }),
    );
    if (!freeNow) continue;
    const slug =
      productHomeSlug(e.offerMappings) ??
      productHomeSlug(e.catalogNs?.mappings) ??
      e.productSlug ??
      e.urlSlug ??
      undefined;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ title: (e.title ?? slug).trim(), url: `${STORE_PRODUCT_BASE}${slug}` });
  }
  return out;
}

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
    // Locale only affects the returned titles; the free-now determination is language-agnostic.
    // Country can affect regional availability, but Epic's weekly free games are global.
    const locale = process.env.EPIC_LOCALE ?? "en-US";
    const country = process.env.EPIC_COUNTRY ?? "US";
    const url = `${PROMOTIONS_URL}?locale=${encodeURIComponent(locale)}&country=${encodeURIComponent(country)}&allowCountries=${encodeURIComponent(country)}`;
    try {
      // Fetch through the browser context so any per-account proxy + cookies apply.
      const resp = await this.context.request.get(url);
      if (!resp.ok()) return [];
      const json = (await resp.json()) as unknown;
      return parseFreeGamesResponse(json, Date.now());
    } catch {
      return [];
    }
  }

  async claimGame(
    game: FreeGame,
  ): Promise<{ claimed: boolean; captcha?: boolean; alreadyOwned?: boolean }> {
    const page = await this.page();
    if (await this.isOwned(game.url)) return { claimed: false, alreadyOwned: true };

    const cta = page.locator("[data-testid='purchase-cta-button']").first();
    if ((await cta.count().catch(() => 0)) === 0) return { claimed: false, alreadyOwned: true };
    await cta.click().catch(() => undefined);

    // The free-checkout opens in a store.epicgames.com/purchase iframe whose confirm button is
    // "Add to library" (paid titles say "Place Order"). An *invisible* hCaptcha runs on submit
    // and passes automatically for a genuine session. Click confirm (+ any EULA) in that frame.
    // The English labels are reliable because the store locale is pinned to en-US above; the
    // extra localized alternatives are a harmless fallback if Epic ever ignores that pin.
    const purchase = await this.waitForFrame(page, /\/purchase/, 12_000);
    if (purchase) {
      const confirm = purchase
        .getByRole("button", {
          name: /add to library|place order|ajouter .*biblioth|passer la commande|obtenir/i,
        })
        .first();
      await confirm.click({ timeout: 10_000 }).catch(() => undefined);
      const agree = purchase
        .getByRole("button", { name: /i agree|accept|j['’]accepte/i })
        .first();
      await agree.click({ timeout: 4000 }).catch(() => undefined);
    }
    await page.waitForTimeout(5000).catch(() => undefined);

    // Verify: only report success if the game is actually in the library now. Otherwise the
    // checkout did not complete (e.g. an interactive hCaptcha challenge) — report honestly
    // rather than claiming a phantom success.
    if (await this.isOwned(game.url)) return { claimed: true };
    if (await this.detectCaptcha(page)) return { claimed: false, captcha: true };
    return { claimed: false };
  }

  /**
   * Force the English store UI regardless of the account's language preference, so the label
   * checks below work for every user. `lang=en-US` is what the /en-US/ path resolves to.
   */
  private static english(url: string): string {
    try {
      const u = new URL(url);
      u.searchParams.set("lang", "en-US");
      return u.toString();
    } catch {
      return url;
    }
  }

  /** Load the product page and decide whether the account already owns it (CTA is "In Library"). */
  private async isOwned(url: string): Promise<boolean> {
    const page = await this.page();
    await page.goto(PlaywrightEpicDriver.english(url), { waitUntil: "domcontentloaded" });
    await page
      .waitForSelector("[data-testid='purchase-cta-button']", { timeout: 12_000 })
      .catch(() => undefined);
    const cta = page.locator("[data-testid='purchase-cta-button']").first();
    if ((await cta.count().catch(() => 0)) === 0) return false;
    const label = ((await cta.textContent().catch(() => "")) ?? "").toLowerCase();
    return /in library|owned|installer|install|dans la biblioth|biblioth[eè]que/i.test(label);
  }

  /** Poll the page's frames for one whose URL matches, up to `timeoutMs`. */
  private async waitForFrame(page: Page, re: RegExp, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = page.frames().find((f) => re.test(f.url()));
      if (frame) return frame;
      await page.waitForTimeout(300).catch(() => undefined);
    }
    return undefined;
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
