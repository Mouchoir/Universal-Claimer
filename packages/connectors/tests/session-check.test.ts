import { describe, expect, it } from "vitest";
import { checkSession, type BrowserCookie } from "../src/index.js";

/**
 * The check that runs on every imported session. Both of the reconnects that looked fine and then
 * failed at the next run were visible in the export itself; these pin down that they are caught,
 * and that a good session is not warned about.
 */

const NOW = Date.UTC(2026, 8, 24);
const future = NOW / 1000 + 86_400;
const past = NOW / 1000 - 86_400;

const c = (name: string, domain: string, expires?: number, value = "x"): BrowserCookie => ({
  name,
  value,
  domain,
  path: "/",
  ...(expires !== undefined ? { expires } : {}),
});

describe("checkSession — Prime Gaming", () => {
  it("names the marketplace an amazon.fr-only session is signed in on", () => {
    const check = checkSession(
      "primegaming",
      [c("at-acbfr", ".amazon.fr", future), c("session-id", ".amazon.fr", future)],
      NOW,
    );
    expect(check.signedInOn).toEqual(["amazon.fr"]);
    expect(check.warnings).toEqual([]);
  });

  it("warns when no marketplace carries a sign-in", () => {
    const check = checkSession(
      "primegaming",
      [c("session-id", ".amazon.fr", future), c("ubid-acbfr", ".amazon.fr", future)],
      NOW,
    );
    expect(check.signedInOn).toEqual([]);
    expect(check.warnings[0]).toMatch(/No Amazon sign-in/);
  });

  it("ignores an expired or empty auth cookie", () => {
    const check = checkSession(
      "primegaming",
      [c("at-main", ".amazon.com", past), c("at-acbde", ".amazon.de", future, "")],
      NOW,
    );
    expect(check.signedInOn).toEqual([]);
  });

  it("reads multi-part marketplaces from the domain, with no region table", () => {
    const check = checkSession(
      "primegaming",
      [
        c("at-acbuk", "www.amazon.co.uk", future),
        c("sess-at-acbbe", ".amazon.com.be"),
        c("at-main", ".amazon.com", future),
      ],
      NOW,
    );
    expect(check.signedInOn).toEqual(["amazon.co.uk", "amazon.com", "amazon.com.be"]);
  });
});

describe("checkSession — Epic", () => {
  it("accepts a live Epic sign-in", () => {
    const check = checkSession("epic", [c("EPIC_SESSION_AP", ".epicgames.com", future)], NOW);
    expect(check.warnings).toEqual([]);
    expect(check.signInNames).toEqual(["EPIC_SESSION_AP"]);
  });

  it("warns when there is no Epic sign-in at all", () => {
    const check = checkSession("epic", [c("cf_clearance", ".epicgames.com", future)], NOW);
    expect(check.warnings[0]).toMatch(/No Epic sign-in/);
  });

  it("warns when every Epic sign-in has expired", () => {
    const check = checkSession(
      "epic",
      [c("EPIC_BEARER_TOKEN", ".epicgames.com", past), c("EPIC_SSO", ".epicgames.com", past)],
      NOW,
    );
    expect(check.warnings[0]).toMatch(/already expired/);
  });
});

describe("checkSession — others", () => {
  it("warns about a Twitch session without its auth cookie", () => {
    expect(checkSession("twitch", [c("unique_id", ".twitch.tv")], NOW).warnings).toHaveLength(1);
    expect(checkSession("twitch", [c("auth-token", ".twitch.tv", future)], NOW).warnings).toEqual([]);
  });

  it("does not guess about Microsoft", () => {
    expect(checkSession("microsoft", [c("anything", ".live.com")], NOW).warnings).toEqual([]);
  });

  it("never returns a cookie value", () => {
    const check = checkSession("epic", [c("EPIC_SSO", ".epicgames.com", future, "s3cr3t")], NOW);
    expect(JSON.stringify(check)).not.toContain("s3cr3t");
  });
});
