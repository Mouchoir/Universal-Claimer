import type { Fingerprint } from "./connector.js";

/**
 * A sensible default per-account fingerprint (Constitution Principle VII). Lives apart from
 * the browser factory so consumers that only need the fingerprint (e.g. the web app at
 * connect time) don't pull in CloakBrowser / Playwright.
 */
export function defaultFingerprint(): Fingerprint {
  return {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    timezoneId: "Europe/Paris",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
  };
}
