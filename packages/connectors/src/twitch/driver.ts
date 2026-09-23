import type { BrowserContext, Page } from "playwright-core";
import type { BrowserCookie, SessionHandle } from "../connector.js";

export interface ResubResult {
  subscribed: boolean;
  alreadyActive?: boolean;
  captcha?: boolean;
  notFound?: boolean;
  /** Why nothing happened, when it was not because the sub is already running. */
  reason?: string;
  /**
   * What "is the account already subscribed?" was answered from, and what the answer rested on.
   * Set on every result that got as far as asking; absent on a 404, or a captcha met before that.
   */
  evidence?: SubEvidence;
}

/**
 * What kind of sub the account holds. `prime` is Twitch's own flag. `paid` is a sub that renews
 * on its own without Prime: only a sub someone pays for on a schedule renews, which is almost
 * always the account itself (a recurring gift from someone else reads the same, and the reply
 * cannot tell them apart). `gift` is kept for when something can tell: the fields this query asks
 * for carry no gift flag, and asking for one is not an option, since a field Twitch does not know
 * gets the whole query rejected. Everything else, including any verdict read off the page, is
 * `unknown` rather than a guess.
 */
export type SubKind = "prime" | "gift" | "paid" | "unknown";

/**
 * How the resub decision was reached. The summary words itself from this, and the run logs it,
 * so "already active" always says whether Twitch said so or the page merely looked that way.
 */
export interface SubEvidence {
  /** Who answered: Twitch's subscription API, or the channel page's markers when it could not. */
  decidedBy: "api" | "page";
  kind: SubKind;
  /** ISO end date of the benefit the verdict rests on, when the API gave one. */
  endsAt?: string;
  /** ISO date that benefit next renews on its own, when the API gave one. */
  renewsAt?: string;
  /** Why the API gave no usable answer. Set exactly when the page decided. */
  apiUnavailable?: string;
  /** HTTP status of the API reply, when one came back. */
  apiHttpStatus?: number;
  /** The first error message in the API reply, when it carried any. */
  apiFirstError?: string;
  /** How many benefits the API listed, when it listed them. */
  listCount?: number;
  /** Whether that list mentions the channel at all, live or lapsed. */
  listHasChannel?: boolean;
  /** The page's subscribe-like `data-a-target` values, when they were read. */
  subscribeishTargets?: string[];
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
  /**
   * When the sub to `channel` ends (ISO), or next renews when it has no end, preferring the
   * Prime-purchased one; undefined when none is readable.
   */
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
  /** ISO date the sub next renews on its own, when Twitch reports one. */
  renewsAt?: string;
  purchasedWithPrime: boolean;
  /**
   * Twitch gave a date for this benefit that does not parse. Dropping it would make the benefit
   * look permanent, which is the answer that skips a renewal, so whether it runs is unknown.
   */
  unreadableDate?: true;
}

/** What asking Twitch's subscription API produced: the answer, or why there is none. */
export interface SubscriptionLookup {
  /** The account's subscription benefits, or null when Twitch could not be asked. */
  subs: SubscriptionInfo[] | null;
  /** HTTP status of the reply, when one came back at all. */
  httpStatus?: number;
  /** The first error message in the reply, on one line and bounded. */
  firstError?: string;
  /** Why `subs` is null, worded to follow "Twitch's API could not be asked: ". */
  failure?: string;
}

/** One line, bounded: this ends up in a run summary and a log line, never a wall of stack. */
function oneLine(value: unknown, max = 160): string {
  const text = String(value instanceof Error ? value.message : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** A date from the reply as ISO, `null` when absent, `undefined` when present but unparseable. */
function isoDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  // Date.parse + isFinite rather than new Date(x).toISOString(): the latter throws a RangeError
  // on a bad date, and one odd benefit must not take the whole answer down with it.
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

type GqlNode = {
  endsAt?: unknown;
  renewsAt?: unknown;
  purchasedWithPrime?: unknown;
  product?: { owner?: { login?: unknown } | null } | null;
} | null;

type GqlResult = {
  data?: {
    currentUser?: {
      subscriptionBenefits?: { edges?: unknown } | null;
    } | null;
  } | null;
  errors?: unknown;
  message?: unknown;
};

function firstErrorOf(result: GqlResult | undefined): string | undefined {
  const errors = result?.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  // A GraphQL error list first; a plain `{ message }` is what a gateway error tends to carry.
  const message =
    first && typeof first === "object"
      ? (first as { message?: unknown }).message
      : result?.message;
  return typeof message === "string" && message.trim() ? oneLine(message) : undefined;
}

/**
 * Read a reply from Twitch's `SubscriptionsManager_User` GraphQL query. Pure + unit-tested; the
 * driver only supplies the status and the raw body.
 *
 * The one rule: only a reply that actually carries the signed-in account's subscription list is
 * an answer. An empty list means "subscribed to nothing", and a renewal follows from it; an error
 * reply, a body that is not JSON, or a reply with no signed-in user means Twitch was not really
 * asked. Reading those as an empty list, as this used to, answered "could not ask" with "you are
 * not subscribed", and the renewal ran against a page that could have said otherwise.
 *
 * Errors that come alongside a readable list are GraphQL's partial result: the fields that failed
 * resolve to null and the rest stands, so the list is kept and the error recorded.
 */
export function readSubscriptionReply(status: number, body: string): SubscriptionLookup {
  let payload: unknown;
  let parsed = true;
  try {
    payload = JSON.parse(body);
  } catch {
    parsed = false;
  }
  try {
    // The endpoint answers with a batch (an array of operation results).
    const first = (Array.isArray(payload) ? payload[0] : payload) as GqlResult | undefined;
    const firstError = parsed ? firstErrorOf(first) : undefined;
    const noted = { httpStatus: status, ...(firstError ? { firstError } : {}) };
    const quoted = firstError ? ` ("${firstError}")` : "";

    if (status < 200 || status > 299) {
      return { subs: null, ...noted, failure: `HTTP ${status}${quoted}` };
    }
    if (!parsed) return { subs: null, ...noted, failure: "the reply was not JSON" };
    const data = first && typeof first === "object" ? first.data : undefined;
    if (!data || typeof data !== "object") {
      return {
        subs: null,
        ...noted,
        failure: firstError ? `Twitch returned an error${quoted}` : "the reply carried no data",
      };
    }
    if (!data.currentUser) {
      return { subs: null, ...noted, failure: `the reply named no signed-in account${quoted}` };
    }
    const edges = data.currentUser.subscriptionBenefits?.edges;
    if (!Array.isArray(edges)) {
      return { subs: null, ...noted, failure: `the reply carried no subscription list${quoted}` };
    }

    const subs: SubscriptionInfo[] = [];
    for (const edge of edges as ({ node?: GqlNode } | null)[]) {
      const node = edge?.node;
      const login = node?.product?.owner?.login;
      const channel = typeof login === "string" ? login.trim().toLowerCase() : "";
      if (!node || !channel) continue;
      const endsAt = isoDate(node.endsAt);
      const renewsAt = isoDate(node.renewsAt);
      const unreadable = endsAt === undefined || renewsAt === undefined;
      subs.push({
        channel,
        ...(endsAt ? { endsAt } : {}),
        ...(renewsAt ? { renewsAt } : {}),
        purchasedWithPrime: node.purchasedWithPrime === true,
        ...(unreadable ? { unreadableDate: true as const } : {}),
      });
    }
    return { subs, ...noted };
  } catch (err) {
    // Nothing above should throw, but a claim must never die on the shape of a reply: whatever
    // did is "could not ask", not "subscribed to nothing".
    const failure = `the reply could not be read (${oneLine(err)})`;
    return { subs: null, httpStatus: status, failure };
  }
}

/**
 * The subscription list in a successful reply body, or null when the body is not an answer (see
 * `readSubscriptionReply`). Never `[]` for a reply that did not carry the list.
 */
export function parseSubscriptionBenefits(raw: string): SubscriptionInfo[] | null {
  return readSubscriptionReply(200, raw).subs;
}

/**
 * Is one of these benefits an active subscription to `channel`?
 *
 * Twitch's `filter: ALL` returns lapsed benefits alongside live ones, so presence in the list
 * says nothing on its own — an expired sub looks exactly like a current one until you read the
 * date. A benefit with no end date is a permanent grant and counts; one whose date did not parse
 * proves nothing and does not.
 */
export function hasActiveSub(
  subs: SubscriptionInfo[],
  channel: string,
  now: number = Date.now(),
): boolean {
  const wanted = channel.trim().toLowerCase();
  return subs.some((s) => {
    if (s.channel !== wanted || s.unreadableDate) return false;
    if (!s.endsAt) return true;
    const end = Date.parse(s.endsAt);
    return Number.isFinite(end) && end > now;
  });
}

/** The kind of one benefit, from the flags the reply carries (see `SubKind`). */
export function subKind(sub: SubscriptionInfo | undefined): SubKind {
  if (!sub) return "unknown";
  if (sub.purchasedWithPrime) return "prime";
  if (sub.renewsAt) return "paid";
  return "unknown";
}

/**
 * What the API says about one channel. Known: the verdict and the benefit it rests on. Unknown:
 * the page has to decide, and the evidence already says so and why.
 *
 * Unknown is never "not subscribed". That is the whole point of keeping the two apart: "not
 * subscribed" starts a resubscribe, and a failed call is no reason to start one.
 */
export type ApiVerdict =
  | { known: true; active: boolean; evidence: SubEvidence }
  | { known: false; evidence: SubEvidence };

export function verdictFromApi(
  lookup: SubscriptionLookup,
  channel: string,
  now: number = Date.now(),
): ApiVerdict {
  const wanted = channel.trim().toLowerCase();
  const mine = lookup.subs?.filter((s) => s.channel === wanted) ?? [];
  const noted = {
    ...(lookup.httpStatus !== undefined ? { apiHttpStatus: lookup.httpStatus } : {}),
    ...(lookup.firstError ? { apiFirstError: lookup.firstError } : {}),
    ...(lookup.subs ? { listCount: lookup.subs.length, listHasChannel: mine.length > 0 } : {}),
  };
  const unknown = (why: string): ApiVerdict => ({
    known: false,
    evidence: { decidedBy: "page", kind: "unknown", apiUnavailable: why, ...noted },
  });

  if (lookup.subs === null) return unknown(lookup.failure ?? "no reason was given");

  const live = mine.filter((s) => hasActiveSub([s], wanted, now));
  // A live benefit settles it whatever else is listed. Without one, "not subscribed" holds only
  // if every benefit for the channel could be read: one with a bad date may be the live one.
  if (live.length === 0 && mine.some((s) => s.unreadableDate)) {
    return unknown("the reply's date for this channel does not parse");
  }
  // Describe the live benefit when there is one, the Prime one first. Otherwise the one that
  // lapsed last: its past end date is what says the renewal is due. By then every benefit for
  // the channel has a readable end date, since one with none would have counted as live.
  const shown =
    live.find((s) => s.purchasedWithPrime) ??
    live[0] ??
    mine.reduce<SubscriptionInfo | undefined>(
      (latest, s) => (!latest || Date.parse(s.endsAt!) > Date.parse(latest.endsAt!) ? s : latest),
      undefined,
    );
  return {
    known: true,
    active: live.length > 0,
    evidence: {
      decidedBy: "api",
      kind: subKind(shown),
      ...(shown?.endsAt ? { endsAt: shown.endsAt } : {}),
      ...(shown?.renewsAt ? { renewsAt: shown.renewsAt } : {}),
      ...noted,
    },
  };
}

/**
 * Real Playwright-backed Twitch driver. Selectors target the current Twitch UI and are
 * best-effort (platform UI changes are the dominant cause of breakage; the connector health
 * monitor guards this). The connector's tests use a fake driver; the resub decision itself is
 * tested against a minimal fake page (tests/twitch.resub.test.ts).
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
    // silently skips the renewal. The page is the fallback, for when the API cannot be reached,
    // and only the page: an API that gave no answer is not an API that said "not subscribed".
    const api = verdictFromApi(await this.lookupSubscriptions(), channel);
    let evidence = api.evidence;
    if (api.known ? api.active : await this.isSubscribed(page)) {
      return { subscribed: false, alreadyActive: true, evidence };
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
      evidence = { ...evidence, subscribeishTargets: seen };
      return {
        subscribed: false,
        reason: seen.length
          ? `no subscribe control matched; the page offered: ${seen.join(", ")}`
          : "no subscribe control found, and the page exposed no subscribe-like controls at all",
        evidence,
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

    if (await this.detectCaptcha(page)) return { subscribed: false, captcha: true, evidence };

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

    // Verify: only report success once Twitch actually shows a subscribed state. The evidence is
    // the verdict that led here, i.e. why a resubscribe was attempted at all.
    await page.waitForTimeout(3000).catch(() => undefined);
    return { subscribed: await this.isSubscribed(page), evidence };
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
   *
   * `subs` is null when Twitch could not be asked, and the lookup says why. The difference
   * matters: an empty list means "you are subscribed to nothing", while a failed call means
   * "unknown". Collapsing both to `[]`, as this used to, turns a network hiccup into a confident
   * wrong answer.
   */
  private async lookupSubscriptions(): Promise<SubscriptionLookup> {
    const page = await this.page();
    try {
      // The request must run from a twitch.tv origin so it carries the site's own context.
      if (!page.url().includes("twitch.tv")) {
        await page.goto("https://www.twitch.tv/", { waitUntil: "domcontentloaded" });
      }
      const cookies = await this.context.cookies("https://www.twitch.tv");
      const token = cookies.find((c) => c.name === "auth-token")?.value ?? "";
      const reply = await page.evaluate(async (tok: string) => {
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
        // The body comes back whatever the status: an error reply still names its error, and
        // the status alone is not the whole story of why Twitch could not answer.
        return { status: res.status, body: await res.text() };
      }, token);
      return readSubscriptionReply(reply.status, reply.body);
    } catch (err) {
      return { subs: null, failure: `the request failed (${oneLine(err)})` };
    }
  }

  /**
   * Whether the account currently subscribes to `channel`, according to Twitch itself.
   * Null when Twitch could not be asked, so the caller can fall back rather than guess.
   */
  async isSubscribedTo(channel: string): Promise<boolean | null> {
    const api = verdictFromApi(await this.lookupSubscriptions(), channel);
    return api.known ? api.active : null;
  }

  /** When the sub to `channel` ends (ISO), or next renews when it has no end date. */
  async getPrimeSubEnd(channel: string): Promise<string | undefined> {
    const wanted = channel.trim().toLowerCase();
    const subs = (await this.lookupSubscriptions()).subs ?? [];
    // Prefer the Prime-purchased entry for this channel; fall back to any sub to it.
    const match =
      subs.find((s) => s.channel === wanted && s.purchasedWithPrime) ??
      subs.find((s) => s.channel === wanted);
    return match?.endsAt ?? match?.renewsAt;
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
