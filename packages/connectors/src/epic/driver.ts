import type { BrowserContext, Frame, Page, Response } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";
import {
  CHECKOUT_TIMING,
  NO_CTA,
  buttonName,
  frameKind,
  isOwnedLabel,
  readFrame,
  walkCheckout,
  type CheckoutProbe,
  type CheckoutTiming,
  type CheckoutView,
  type EpicClaimAttempt,
} from "./checkout.js";

/**
 * Where the signed-in check ended up.
 *
 * `blocked` is kept apart from `signed_out` because the two call for opposite responses: a
 * Cloudflare challenge says nothing about the session, and telling the operator to reconnect
 * over it has them replace a good session with an identical one.
 */
export type EpicSignInState = "signed_in" | "signed_out" | "blocked";

export interface EpicSignInCheck {
  state: EpicSignInState;
  /**
   * Where the check stopped: the URL path, prefixed by its host when that is not
   * www.epicgames.com. Never the query string - the login page's carries redirect parameters,
   * which nobody reading a summary has any use for.
   */
  path: string;
  /** HTTP status of the last page document seen, when there was one. */
  status?: number;
  /**
   * The first landing was the login page, and Epic's login page sent the browser back to the
   * account page. Kept on a `blocked` verdict too, when the page it came back to was challenged.
   */
  bounced: boolean;
}

/**
 * How a password login ended. Not a boolean: the sign-in check it ends on has three outcomes, and
 * folding a Cloudflare challenge into "login failed" sends the operator off to fix credentials
 * that were never the problem.
 */
export type EpicLoginResult = { captcha: true } | { captcha?: false; check: EpicSignInCheck };

/** How long the signed-in check gives Epic (and Cloudflare) to settle. */
export interface SignInTiming {
  /** How long Epic's login page gets to renew the session and bounce back to the account. */
  bounceMs: number;
  /** How long a Cloudflare challenge gets to clear by itself. */
  challengeMs: number;
  /** How often the page is looked at again while waiting. */
  pollMs: number;
}

export const SIGN_IN_TIMING: SignInTiming = { bounceMs: 25_000, challengeMs: 20_000, pollMs: 500 };

/**
 * The few things the signed-in check reads from the page, kept behind an interface so the
 * waiting - the part that decides the verdict - is unit-testable without a browser.
 */
export interface SignInProbe {
  /** The page's current URL. */
  url(): string;
  /** HTTP status of the latest page document, if one has been seen. */
  status(): number | undefined;
  /** Is the page currently a Cloudflare challenge? */
  challenged(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The login page, as the check has always recognised it. */
export function isLoginUrl(url: string): boolean {
  return url.includes("/login") || url.includes("id.epicgames.com");
}

/** An `/account/...` page - where Epic's login page sends a session it managed to renew. */
function isAccountUrl(url: string): boolean {
  try {
    return /(^|\/)account(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** A URL reduced to what a summary may say about it: host (when not the usual one) and path. */
export function wherePath(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return `${u.protocol}${u.pathname}`;
    return u.host === "www.epicgames.com" ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] || "(no page)";
  }
}

/** Poll `done` until it holds or `budgetMs` has passed; true if it held. */
async function waitUntil(
  probe: SignInProbe,
  budgetMs: number,
  pollMs: number,
  done: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const deadline = probe.now() + budgetMs;
  for (;;) {
    if (await done()) return true;
    const left = deadline - probe.now();
    if (left <= 0) return false;
    await probe.sleep(Math.min(pollMs, left));
  }
}

/**
 * Decide whether the page the account URL landed on means signed in, waiting where Epic or
 * Cloudflare are known to be mid-way through something.
 *
 * Epic's short-lived tokens (EPIC_BEARER_TOKEN, EPIC_SSO) last hours, not days. Once they lapse,
 * the account page sends the browser to the login page, and the login page - when the
 * longer-lived cookies behind them are still good - renews the tokens and bounces straight back.
 * Reading the URL the moment the document loaded caught that bounce half-way and called a live
 * session dead. So a login landing gets a bounded wait for the bounce; any other landing keeps
 * the verdict it always had, so a session that passed before still passes. Nothing here waits
 * for network idle: Epic's pages keep connections open and it may never come.
 *
 * A Cloudflare challenge keeps the account URL, so it used to read as signed in. It now gets its
 * own bounded wait (a managed challenge usually clears itself and reloads), and one that does not
 * clear is reported as `blocked` rather than as either session state. The account page a bounce
 * lands on is a fresh document that can be challenged just like the first, so it gets the same
 * wait.
 */
export async function settleSignIn(
  probe: SignInProbe,
  timing: SignInTiming = SIGN_IN_TIMING,
): Promise<EpicSignInCheck> {
  const verdict = (state: EpicSignInState, bounced = false): EpicSignInCheck => {
    const status = probe.status();
    return {
      state,
      path: wherePath(probe.url()),
      ...(status !== undefined ? { status } : {}),
      bounced,
    };
  };

  const challengeClears = () =>
    waitUntil(probe, timing.challengeMs, timing.pollMs, async () => !(await probe.challenged()));

  if (!(await challengeClears())) return verdict("blocked");

  // Today's pass condition, unchanged: anywhere but the login page is signed in.
  if (!isLoginUrl(probe.url())) return verdict("signed_in");

  const back = await waitUntil(probe, timing.bounceMs, timing.pollMs, () => {
    const url = probe.url();
    return isAccountUrl(url) && !isLoginUrl(url);
  });
  // Called signed in on the URL alone, a challenge on the page the bounce came back to would send
  // the run on to fail somewhere further along, which is the mistake the first wait is there for.
  if (back) return verdict((await challengeClears()) ? "signed_in" : "blocked", true);
  // The login page can itself be put behind a challenge; that is still not a verdict on the
  // session.
  if (await probe.challenged()) return verdict("blocked");
  return verdict("signed_out");
}

/**
 * Cloudflare's challenge page, recognised by its own scaffolding: element ids and a script global
 * that are the same in every language. Deliberately not `/cdn-cgi/challenge-platform/` scripts -
 * Cloudflare injects those into ordinary pages too, for bot scoring.
 */
const CF_CHALLENGE_MARKERS =
  "#challenge-form, #challenge-stage, #challenge-running, #challenge-error-text, #cf-challenge-running";

/**
 * Did a navigation fail only because another one replaced it? That is what Epic's login page
 * bouncing back looks like when it happens before the login document finished loading - the
 * bounce is the good outcome, not an error. Anything else keeps throwing.
 */
function isInterruptedNavigation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /interrupted by another navigation|Navigation to .* was interrupted/i.test(message);
}

/** A currently-free Epic game (title + absolute product URL). */
export interface FreeGame {
  title: string;
  url: string;
  /**
   * Epic's own offer type — BASE_GAME, ADD_ON, BUNDLE, DLC…
   *
   * Kept because they do not behave alike at checkout, and a failure that does not say which
   * kind it was leaves you guessing. An ADD_ON in particular is content for another game, and
   * whether it can be claimed at all may depend on owning that game.
   */
  kind?: string;
}

/**
 * The page-interaction surface the Epic connector needs. Abstracted from raw Playwright so
 * the connector's decision logic is unit-testable with a fake driver (contract tests), and
 * the brittle DOM specifics live in one place.
 */
export interface EpicPageDriver {
  applyCookies(cookies: BrowserCookie[]): Promise<void>;
  /**
   * Is this browser signed in to Epic? Opens the account page and reports where it ended up -
   * after giving Epic's login page its chance to renew the session (see {@link settleSignIn}).
   */
  checkSignIn(): Promise<EpicSignInCheck>;
  /**
   * Log in with a password. Ends on the same check as {@link checkSignIn} and hands it back
   * whole, so the caller neither loses the `blocked` verdict nor opens the account page twice.
   */
  loginWithPassword(email: string, password: string, totp?: string): Promise<EpicLoginResult>;
  /** Free games claimable right now (title + product URL). */
  listClaimableGames(): Promise<FreeGame[]>;
  /**
   * Claim one game.
   *
   * `reason` says where the checkout stopped when the claim did not go through (see
   * {@link walkCheckout}), so a failure can say more than that it failed. There is no retry with
   * a solved captcha token: Epic's checkout runs its hCaptcha inside its own purchase window,
   * where a token solved elsewhere has nowhere to go, so a checkout captcha is a person's to clear.
   */
  claimGame(game: FreeGame): Promise<EpicClaimAttempt>;
  /** The account's own display name on the service, if it can be read. */
  getUsername(): Promise<string | undefined>;
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
  offerType?: string | null;
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
    out.push({
      title: (e.title ?? slug).trim(),
      url: `${STORE_PRODUCT_BASE}${slug}`,
      ...(e.offerType ? { kind: e.offerType } : {}),
    });
  }
  return out;
}

/** The first line of an error, which for Playwright is the part that says what went wrong. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}

/**
 * Wait on the page's clock. A page that has closed or crashed has no clock left: its
 * waitForTimeout fails at once, and returning then would turn every polling loop into a spin
 * until its deadline, so the wait falls back to the process's own timer. The next read of the
 * page says what happened to it.
 */
async function pause(page: Page, ms: number): Promise<void> {
  try {
    await page.waitForTimeout(ms);
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * How long a verification reload gets to load. Well under Playwright's default 30 s: the walk
 * reloads up to three times, and a reload that has not loaded by then is a "not yet" (the
 * post-order launcher dialog can hold a page's load, per feldorn/free-games-claimer v2.11.15),
 * which the next reload or the next run settles.
 */
const VERIFY_LOAD_MS = 15_000;

const CTA = "[data-testid='purchase-cta-button']";

/**
 * Real Playwright-backed driver. Selectors target the current Epic UI and are best-effort:
 * platform UI changes are the dominant cause of connector breakage (see research), so this
 * is exactly the surface the connector health monitor guards. Mostly not exercised in unit
 * tests (those use a fake driver; the sign-in verdict lives in {@link settleSignIn} and the
 * checkout's in {@link walkCheckout}, which are); validated in a live/browser environment.
 */
export class PlaywrightEpicDriver implements EpicPageDriver {
  private readonly context: BrowserContext;
  private readonly timing: SignInTiming;
  private readonly checkout: CheckoutTiming;
  constructor(
    session: SessionHandle,
    timing: SignInTiming = SIGN_IN_TIMING,
    checkout: CheckoutTiming = CHECKOUT_TIMING,
  ) {
    this.context = session.context;
    this.timing = timing;
    this.checkout = checkout;
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

  async checkSignIn(): Promise<EpicSignInCheck> {
    const page = await this.page();
    // The latest page document, kept current through redirects, the login page's bounce and a
    // challenge's own reload - it is what carries Cloudflare's verdict and the status.
    let doc: Response | null = null;
    const onResponse = (r: Response) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) doc = r;
      } catch {
        // A response without a frame (a service worker's) is not the page document.
      }
    };
    page.on("response", onResponse);
    try {
      try {
        // Logged-in users reach the account page; anonymous users are redirected to login.
        const first = await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded" });
        doc ??= first;
      } catch (err) {
        if (!isInterruptedNavigation(err)) throw err;
      }
      return await settleSignIn(
        {
          url: () => page.url(),
          status: () => doc?.status(),
          challenged: () => this.isChallenge(page, doc),
          sleep: (ms) => page.waitForTimeout(ms).catch(() => undefined),
          now: () => Date.now(),
        },
        this.timing,
      );
    } finally {
      page.off("response", onResponse);
    }
  }

  /**
   * Is the page a Cloudflare challenge? Cloudflare's own `cf-mitigated: challenge` header on the
   * latest document is the documented signal; the challenge page's markup backs it up for a
   * challenge that arrives without it. None of it is page text, so it reads the same in every
   * language.
   *
   * Not the `__cf_chl_` URL tokens: a solved challenge reloads into the real page with them still
   * in the query (`/account/personal?__cf_chl_f_tk=...` is the account page itself), so they
   * outlive the challenge and would hold a cleared one as blocked until the wait ran out.
   */
  private async isChallenge(page: Page, doc: Response | null): Promise<boolean> {
    try {
      if ((doc?.headers()["cf-mitigated"] ?? "").toLowerCase() === "challenge") return true;
    } catch {
      // No readable headers; fall through to the page itself.
    }
    if ((await page.locator(CF_CHALLENGE_MARKERS).count().catch(() => 0)) > 0) return true;
    return page
      .evaluate("typeof window._cf_chl_opt !== 'undefined'")
      .then((v) => v === true)
      .catch(() => false);
  }

  async loginWithPassword(email: string, password: string, totp?: string): Promise<EpicLoginResult> {
    const page = await this.page();
    await page.goto("https://www.epicgames.com/id/login/epic", { waitUntil: "domcontentloaded" });
    await page.fill("#email", email).catch(() => undefined);
    await page.fill("#password", password).catch(() => undefined);
    await page.click("#sign-in").catch(() => undefined);
    if (await this.detectCaptcha(page)) return { captcha: true };
    if (totp) {
      await page.fill("input[name='code']", totp).catch(() => undefined);
      await page.click("#continue").catch(() => undefined);
    }
    return { check: await this.checkSignIn() };
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

  async claimGame(game: FreeGame): Promise<EpicClaimAttempt> {
    const page = await this.page();
    if (await this.isOwned(game.url)) return { claimed: false, alreadyOwned: true };

    const cta = page.locator(CTA).first();
    // Not "already owned". Ownership is what isOwned just read off the button's own label; no
    // button at all means the page did not look the way this code expects - a challenge, a page
    // that never rendered, a renamed test id - and calling that owned is how a claim that never
    // happened reported itself as nothing to do.
    if ((await cta.count().catch(() => 0)) === 0) return { claimed: false, reason: NO_CTA };

    // The free checkout opens in a purchase window (an iframe) whose confirm button is "Add to
    // library"; an invisible hCaptcha runs on submit and passes by itself for a genuine session.
    // The English labels hold because the store locale is pinned to en-US, both in the URL and
    // in the browser context's own locale. Only the verdict is Epic's; see walkCheckout for how
    // each step is read and recorded.
    return walkCheckout(this.checkoutProbe(page, game.url), this.checkout);
  }

  /** The checkout walk's view of this page: every Epic frame read in one go, clicks with a delay. */
  private checkoutProbe(page: Page, url: string): CheckoutProbe {
    let frames = new Map<string, Frame>();
    return {
      look: async () => {
        const main = page.mainFrame();
        // All at once: each frame gets up to FRAME_READ_MS, and one after the other a stuck
        // frame or two would stretch every look, and every step budget with it.
        const read = await Promise.all(
          page.frames().map(async (frame, i) => {
            const kind = frameKind(frame, main);
            const raw = kind ? await readFrame(frame) : undefined;
            const id = String(i);
            return kind && raw ? { id, frame, view: { id, kind, ...raw } } : undefined;
          }),
        );
        const next = new Map<string, Frame>();
        const views: CheckoutView[] = [];
        for (const r of read) {
          if (!r) continue;
          next.set(r.id, r.frame);
          views.push(r.view);
        }
        frames = next;
        return views;
      },
      clickCta: async () => {
        try {
          await page.locator(CTA).first().click({ delay: 11, timeout: 10_000 });
          return undefined;
        } catch (err) {
          return firstLine(err);
        }
      },
      press: async (view, label) => {
        const frame = frames.get(view.id);
        if (!frame) return false;
        // The whole label, not a substring of some other button's (see buttonName). A delay, as
        // vogler dev epic-games.js clicks every checkout button.
        return frame
          .getByRole("button", { name: buttonName(label) })
          .first()
          .click({ delay: 11, timeout: 5_000 })
          .then(
            () => true,
            () => false,
          );
      },
      agree: async (view) => {
        const frame = frames.get(view.id);
        if (!frame) return false;
        const box = frame.locator("input#agree").first();
        // A styled checkbox can be a hidden input behind its label, which a normal check refuses.
        return box.check({ timeout: 5_000 }).then(
          () => true,
          () =>
            box.check({ force: true, timeout: 5_000 }).then(
              () => true,
              () => false,
            ),
        );
      },
      // A reload that fails or runs out of VERIFY_LOAD_MS says nothing about ownership; it is a
      // "not yet".
      owned: () => this.isOwned(url, VERIFY_LOAD_MS).catch(() => false),
      ctaLabel: () => this.ctaLabel().catch(() => undefined),
      closed: () => page.isClosed(),
      sleep: (ms) => pause(page, ms),
      now: () => Date.now(),
    };
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

  /**
   * Load the product page and decide whether the account already owns it (CTA is "In Library").
   * `loadMs` bounds the load when this is a verification reload (see VERIFY_LOAD_MS).
   */
  private async isOwned(url: string, loadMs?: number): Promise<boolean> {
    const page = await this.page();
    await page.goto(PlaywrightEpicDriver.english(url), {
      waitUntil: "domcontentloaded",
      ...(loadMs !== undefined ? { timeout: loadMs } : {}),
    });
    await page.waitForSelector(CTA, { timeout: 12_000 }).catch(() => undefined);
    const cta = page.locator(CTA).first();
    if ((await cta.count().catch(() => 0)) === 0) return false;
    // The button renders empty, then "Loading", before it says anything about the account; read
    // too early, an owned game looks unowned (vogler dev epic-games.js, commit 5938bf46).
    const deadline = Date.now() + this.checkout.ctaSettleMs;
    let label = "";
    for (;;) {
      label = ((await cta.textContent().catch(() => "")) ?? "").trim();
      if ((label && !/^loading/i.test(label)) || Date.now() >= deadline) break;
      await pause(page, this.checkout.pollMs);
    }
    return isOwnedLabel(label);
  }

  /** The purchase button's current text, which is the store's own account of where this ended. */
  private async ctaLabel(): Promise<string | undefined> {
    const page = await this.page();
    const cta = page.locator(CTA).first();
    if ((await cta.count().catch(() => 0)) === 0) return NO_CTA;
    const label = ((await cta.textContent().catch(() => "")) ?? "").trim();
    return label || undefined;
  }

  /**
   * Read the signed-in account's display name. Epic exposes it on the account page in a
   * `data-component`-tagged field; falls back to the EPIC_SSO display-name cookie. Best-effort:
   * a missing name never fails a claim.
   */
  async getUsername(): Promise<string | undefined> {
    const page = await this.page();
    try {
      await page.goto(PlaywrightEpicDriver.english(ACCOUNT_URL), { waitUntil: "domcontentloaded" });
      const name = await page
        .locator("input#displayName, [data-component='AccountDisplayName']")
        .first()
        .inputValue()
        .catch(async () =>
          page
            .locator("[data-component='AccountDisplayName']")
            .first()
            .textContent()
            .catch(() => null),
        );
      const trimmed = (name ?? "").trim();
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
    return (await page.locator("iframe[src*='hcaptcha'], iframe[src*='recaptcha']").count()) > 0;
  }
}
