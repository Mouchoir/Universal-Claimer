import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

export interface ResubResult {
  subscribed: boolean;
  alreadyActive?: boolean;
  captcha?: boolean;
  notFound?: boolean;
  /** Why nothing happened, when it was not because the sub is already running. */
  reason?: string;
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
  /** The account's own Twitch username, if readable. */
  getUsername(): Promise<string | undefined>;
  /** When the active Prime sub to `channel` ends (ISO), if one is active and readable. */
  getPrimeSubEnd(channel: string): Promise<string | undefined>;
  /**
   * Whether the account subscribes to `channel`, per Twitch's own subscription list.
   * Null when Twitch could not be asked — the caller then falls back to reading the page.
   */
  isSubscribedTo(channel: string): Promise<boolean | null>;
  getCookies(): Promise<BrowserCookie[]>;
  goto(url: string): Promise<void>;
}

export type TwitchDriverFactory = (session: SessionHandle) => TwitchPageDriver;

/** One subscription as reported by Twitch's GraphQL API. `channel` is the owner login, lowercased. */
export interface SubscriptionInfo {
  channel: string;
  /** ISO end date, when Twitch reports one (a permanent grant has none). */
  endsAt?: string;
  purchasedWithPrime: boolean;
}

/**
 * Parse Twitch's `SubscriptionsManager_User` GraphQL response into the subscriptions we care
 * about. Pure + unit-tested; the driver only supplies the raw response body. Tolerates a missing
 * or malformed payload by returning an empty list rather than throwing into a claim.
 */
export function parseSubscriptionBenefits(raw: string): SubscriptionInfo[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  // The endpoint answers with a batch (an array of operation results).
  const first = Array.isArray(payload) ? payload[0] : payload;
  const edges =
    (
      first as {
        data?: {
          currentUser?: {
            subscriptionBenefits?: {
              edges?: {
                node?: {
                  endsAt?: string | null;
                  purchasedWithPrime?: boolean | null;
                  product?: { owner?: { login?: string | null } | null } | null;
                };
              }[];
            } | null;
          } | null;
        };
      }
    )?.data?.currentUser?.subscriptionBenefits?.edges ?? [];

  const out: SubscriptionInfo[] = [];
  for (const edge of edges) {
    const node = edge?.node;
    const channel = node?.product?.owner?.login?.trim().toLowerCase();
    if (!channel) continue;
    const endsAt = node?.endsAt ? new Date(node.endsAt).toISOString() : undefined;
    out.push({
      channel,
      ...(endsAt ? { endsAt } : {}),
      purchasedWithPrime: Boolean(node?.purchasedWithPrime),
    });
  }
  return out;
}

/**
 * Is one of these benefits an active subscription to `channel`?
 *
 * Twitch's `filter: ALL` returns lapsed benefits alongside live ones, so presence in the list
 * says nothing on its own — an expired sub looks exactly like a current one until you read the
 * date. A benefit with no end date is a permanent grant and counts.
 */
export function hasActiveSub(
  subs: SubscriptionInfo[],
  channel: string,
  now: number = Date.now(),
): boolean {
  const wanted = channel.trim().toLowerCase();
  return subs.some((s) => {
    if (s.channel !== wanted) return false;
    if (!s.endsAt) return true;
    const end = Date.parse(s.endsAt);
    return Number.isFinite(end) && end > now;
  });
}

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
    // Submit via the form's submit button rather than its visible label, which is localized.
    const submit =
      (await this.firstPresent(page, [
        "button[data-a-target='passport-login-button']",
        "form button[type='submit']",
      ])) ?? page.getByRole("button", { name: /log ?in/i }).first();
    await submit.click().catch(() => undefined);
    if (await this.detectCaptcha(page)) return { authenticated: false, captcha: true };
    if (totp) {
      await page.fill("input[autocomplete='one-time-code']", totp).catch(() => undefined);
      const verify =
        (await this.firstPresent(page, [
          "button[data-a-target='tw-core-button']",
          "form button[type='submit']",
        ])) ?? page.getByRole("button", { name: /submit|verify/i }).first();
      await verify.click().catch(() => undefined);
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

    // Twitch renders its UI in the *account's* language and offers no reliable per-URL locale
    // override, so this flow keys off `data-a-target` attributes, which Twitch keeps in English
    // no matter the display language — making it work for users in any locale. Visible-text
    // matching is kept only as a last-resort fallback.
    // Ask Twitch before reading the page. The subscription list is authoritative and carries
    // expiry dates; the page only shows affordances, and telling "subscribed" from "not" by
    // which buttons are present is guesswork that has already been wrong in the direction that
    // silently skips the renewal. The page is the fallback, for when the API cannot be reached.
    const known = await this.isSubscribedTo(channel);
    if (known === true) return { subscribed: false, alreadyActive: true };
    if (known === null && (await this.isSubscribed(page))) {
      return { subscribed: false, alreadyActive: true };
    }

    const subBtn = await this.firstPresent(page, [
      "button[data-a-target='subscribe-button']",
      "[data-a-target='subscribe-button']",
      // A lapsed subscriber is offered "Resubscribe", which is a different control from the
      // first-time "Subscribe" one. Matching the family covers both without having to know
      // every name Twitch uses — minus the gift button, which is shown to everyone, and minus
      // the subscribed marker, which would mean we should not be here at all.
      "button[data-a-target*='subscribe']:not([data-a-target*='gift']):not([data-a-target='subscribed-button'])",
      "[data-a-target*='subscribe']:not([data-a-target*='gift']):not([data-a-target='subscribed-button'])",
    ]);
    if (!subBtn) {
      // Emphatically not "already subscribed". Not finding the control means the page did not
      // look the way this code expects — a renamed attribute, a session that is not signed in,
      // a channel with no subscriptions. Reporting that as an active sub is how a lapsed
      // account was told for weeks that its renewal had nothing to do.
      // Name what the page did offer. Guessing a third selector blind has already cost two
      // rounds; the attributes actually present are what settle it.
      const seen = await this.subscribeishTargets(page);
      return {
        subscribed: false,
        reason: seen.length
          ? `no subscribe control matched; the page offered: ${seen.join(", ")}`
          : "no subscribe control found, and the page exposed no subscribe-like controls at all",
      };
    }
    await subBtn.click().catch(() => undefined);

    // Choose the Prime tier, then confirm. Attribute selectors first, text as fallback.
    const prime = await this.firstPresent(page, [
      "[data-a-target='prime-subscribe-button']",
      "[data-a-target*='prime']",
    ]);
    if (prime) await prime.click().catch(() => undefined);
    else await page.getByText(/Prime/i).first().click().catch(() => undefined);

    if (await this.detectCaptcha(page)) return { subscribed: false, captcha: true };

    const confirm = await this.firstPresent(page, [
      "[data-a-target='prime-subscribe-confirmation-button']",
      "[data-a-target='subscribe-with-prime-button']",
    ]);
    if (confirm) await confirm.click().catch(() => undefined);
    else
      await page
        .getByRole("button", { name: /Prime/i })
        .last()
        .click()
        .catch(() => undefined);

    // Verify: only report success once Twitch actually shows a subscribed state.
    await page.waitForTimeout(3000).catch(() => undefined);
    return { subscribed: await this.isSubscribed(page) };
  }

  /**
   * Twitch stores the signed-in username in a plain `login` cookie — language-independent and
   * free to read (no page load), so it works whatever the account's UI language is.
   */
  async getUsername(): Promise<string | undefined> {
    const cookies = await this.context.cookies("https://www.twitch.tv");
    const login = cookies.find((c) => c.name === "login" || c.name === "name");
    const value = login?.value ? decodeURIComponent(login.value).trim() : "";
    return value.length > 0 ? value : undefined;
  }

  /**
   * Read the account's subscriptions — including each one's exact end date — from Twitch's own
   * GraphQL endpoint, the same one the site itself calls, using the operator's session. Scraping
   * was not viable: Twitch's old /settings/subscriptions page redirects away and the remaining UI
   * exposes no machine-readable date. This is also fully language-independent.
   */
  /**
   * The account's subscription benefits, or null when Twitch could not be asked.
   *
   * The difference matters: an empty list means "you are subscribed to nothing", while a failed
   * call means "unknown". Collapsing both to `[]`, as this used to, turns a network hiccup into
   * a confident wrong answer.
   */
  private async fetchSubscriptions(): Promise<SubscriptionInfo[] | null> {
    const page = await this.page();
    try {
      // The request must run from a twitch.tv origin so it carries the site's own context.
      if (!page.url().includes("twitch.tv")) {
        await page.goto("https://www.twitch.tv/", { waitUntil: "domcontentloaded" });
      }
      const cookies = await this.context.cookies("https://www.twitch.tv");
      const token = cookies.find((c) => c.name === "auth-token")?.value ?? "";
      const raw = await page.evaluate(async (tok: string) => {
        const res = await fetch("https://gql.twitch.tv/gql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Public web client id, as sent by the site itself.
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
            Authorization: tok ? `OAuth ${tok}` : "",
          },
          body: JSON.stringify([
            {
              operationName: "SubscriptionsManager_User",
              variables: {},
              query: `query SubscriptionsManager_User {
                currentUser {
                  login
                  subscriptionBenefits(first: 100, criteria: { filter: ALL, platform: WEB }) {
                    edges { node { endsAt renewsAt purchasedWithPrime product { owner { login } } } }
                  }
                }
              }`,
            },
          ]),
        });
        return res.ok ? await res.text() : null;
      }, token);
      // A non-ok response yields null above, which is "could not ask" rather than "nothing".
      return raw === null ? null : parseSubscriptionBenefits(raw);
    } catch {
      return null;
    }
  }

  /**
   * Whether the account currently subscribes to `channel`, according to Twitch itself.
   * Null when Twitch could not be asked, so the caller can fall back rather than guess.
   */
  async isSubscribedTo(channel: string): Promise<boolean | null> {
    const subs = await this.fetchSubscriptions();
    return subs === null ? null : hasActiveSub(subs, channel);
  }

  /** When the active Prime sub to `channel` ends (ISO), if Twitch reports one. */
  async getPrimeSubEnd(channel: string): Promise<string | undefined> {
    const wanted = channel.trim().toLowerCase();
    const subs = (await this.fetchSubscriptions()) ?? [];
    // Prefer the Prime-purchased entry for this channel; fall back to any sub to it.
    const match =
      subs.find((s) => s.channel === wanted && s.purchasedWithPrime) ??
      subs.find((s) => s.channel === wanted);
    return match?.endsAt;
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

  /** Return a locator for the first selector present on the page, or null if none match. */
  private async firstPresent(page: Page, selectors: string[]) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) return loc;
    }
    return null;
  }

  /**
   * Is the account currently subscribed to the open channel? Uses Twitch's language-independent
   * `data-a-target` markers (a subscribed channel exposes the sub-gift / manage affordances and
   * drops the plain subscribe button) so this works whatever the UI language is.
   */
  private async isSubscribed(page: Page): Promise<boolean> {
    const subscribedMarker = await this.firstPresent(page, [
      "[data-a-target='subscribed-button']",
      "[data-a-target='manage-subscription-button']",
      // Deliberately NOT the gift button: Twitch shows that to everyone, because anyone may gift
      // a sub to a channel they have never subscribed to. Treating it as proof of a subscription
      // reported a lapsed account as active, and skipped the renewal it was there to perform.
    ]);
    return subscribedMarker !== null;
  }

  /**
   * Every `data-a-target` on the page that mentions subscribing, deduped and capped.
   *
   * Reported when the subscribe control cannot be found, because the alternative is guessing at
   * Twitch's naming from the outside — which is exactly how a lapsed account was told for weeks
   * that its renewal had nothing to do.
   */
  private async subscribeishTargets(page: Page): Promise<string[]> {
    try {
      const targets = await page.$$eval("[data-a-target]", (nodes) =>
        nodes
          .map((n) => n.getAttribute("data-a-target") ?? "")
          .filter((t) => /sub|prime|tier/i.test(t)),
      );
      return [...new Set(targets)].sort().slice(0, 12);
    } catch {
      return [];
    }
  }

  private async detectCaptcha(page: Page): Promise<boolean> {
    return (await page.locator("iframe[src*='hcaptcha'], iframe[src*='recaptcha']").count()) > 0;
  }
}
