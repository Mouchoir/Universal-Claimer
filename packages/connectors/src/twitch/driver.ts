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
  /** The account's own Twitch username, if readable. */
  getUsername(): Promise<string | undefined>;
  /** When the active Prime sub to `channel` ends (ISO), if one is active and readable. */
  getPrimeSubEnd(channel: string): Promise<string | undefined>;
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
    if (await this.isSubscribed(page)) return { subscribed: false, alreadyActive: true };

    const subBtn = await this.firstPresent(page, [
      "button[data-a-target='subscribe-button']",
      "[data-a-target='subscribe-button']",
    ]);
    if (!subBtn) {
      // No subscribe affordance (not logged in, or channel has no subs) → nothing to do.
      return { subscribed: false, alreadyActive: true };
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
  private async fetchSubscriptions(): Promise<SubscriptionInfo[]> {
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
      return raw ? parseSubscriptionBenefits(raw) : [];
    } catch {
      return [];
    }
  }

  /** When the active Prime sub to `channel` ends (ISO), if Twitch reports one. */
  async getPrimeSubEnd(channel: string): Promise<string | undefined> {
    const wanted = channel.trim().toLowerCase();
    const subs = await this.fetchSubscriptions();
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
      "[data-a-target='subscription-gift-button']",
    ]);
    return subscribedMarker !== null;
  }

  private async detectCaptcha(page: Page): Promise<boolean> {
    return (await page.locator("iframe[src*='hcaptcha'], iframe[src*='recaptcha']").count()) > 0;
  }
}
