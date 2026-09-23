import type { BrowserCookie } from "./connector.js";
import { isAmazonAuthCookie, signedInMarketplaces } from "./primegaming/driver.js";

/**
 * A look at an imported session before it is stored: does it carry a sign-in at all?
 *
 * Imports were stored as they came, and a session that could never work replaced the one before
 * it and failed only at the next run — hours later, far from the moment the operator could have
 * fixed it by signing in and sending it again. Both of the failures that prompted this were
 * visible in the export itself: a Prime Gaming session signed in on no Amazon marketplace the
 * claim would reach, and an Epic session carrying no live Epic sign-in.
 *
 * Names and expiry only, never values. And it only warns: cookie names are Amazon's and Epic's to
 * change, so refusing on them would turn a rename into a service nobody can connect.
 */

export interface SessionCheck {
  /** The sign-in cookie names found, for the log. Names only. */
  signInNames: string[];
  /** For a marketplace service, where the account is signed in (e.g. `amazon.fr`). */
  signedInOn?: string[];
  /** What looks wrong, in words the operator can act on. Empty when nothing does. */
  warnings: string[];
}


/** Whether a cookie is still good: session cookies count, expired ones do not. */
function live(cookie: BrowserCookie, nowSec: number): boolean {
  if (!cookie.value) return false;
  return cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > nowSec;
}

/** Epic's sign-in cookies. Any live one means the account page has something to go on. */
const EPIC_SIGN_IN = ["EPIC_SSO", "EPIC_BEARER_TOKEN", "EPIC_SESSION_AP", "EPIC_SSO_RM"];

export function checkSession(
  serviceId: string,
  cookies: BrowserCookie[],
  now: number = Date.now(),
): SessionCheck {
  const nowSec = Math.floor(now / 1000);

  if (serviceId === "primegaming") {
    const auth = cookies.filter((c) => isAmazonAuthCookie(c.name, c.domain) && live(c, nowSec));
    // The same reading the claim makes, so what the page says here is what the run will try.
    const signedInOn = signedInMarketplaces(cookies, now).sort();
    return {
      signInNames: [...new Set(auth.map((c) => c.name))].sort(),
      signedInOn,
      warnings:
        signedInOn.length === 0
          ? [
              "No Amazon sign-in was found in this session. Sign in on your own marketplace's " +
                "Luna page in this browser (for example luna.amazon.fr), then connect again.",
            ]
          : [],
    };
  }

  if (serviceId === "epic") {
    const present = cookies.filter((c) => EPIC_SIGN_IN.includes(c.name));
    const alive = present.filter((c) => live(c, nowSec));
    const warnings: string[] = [];
    if (present.length === 0) {
      warnings.push(
        "No Epic sign-in was found in this session. Open epicgames.com/account in this browser, " +
          "make sure it shows your account, then connect again.",
      );
    } else if (alive.length === 0) {
      warnings.push(
        "The Epic sign-in in this session has already expired. Open epicgames.com/account in " +
          "this browser so Epic renews it, then connect again.",
      );
    }
    return { signInNames: [...new Set(alive.map((c) => c.name))].sort(), warnings };
  }

  if (serviceId === "twitch") {
    const auth = cookies.filter((c) => c.name === "auth-token" && live(c, nowSec));
    return {
      signInNames: auth.length ? ["auth-token"] : [],
      warnings: auth.length
        ? []
        : ["No Twitch sign-in was found in this session. Sign in on twitch.tv, then connect again."],
    };
  }

  // Microsoft's sign-in spans several hosts and cookie names it varies freely; there is no single
  // name worth warning about.
  return { signInNames: [], warnings: [] };
}
