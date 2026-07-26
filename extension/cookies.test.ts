import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module shared with the browser extension runtime.
import { SERVICES, serviceForUrl, toNetscape, dedupeCookies } from "./cookies.js";

describe("serviceForUrl", () => {
  it("maps known hosts (incl. subdomains) to a service", () => {
    expect(serviceForUrl("https://www.twitch.tv/login")).toBe("twitch");
    expect(serviceForUrl("https://store.epicgames.com/p/x")).toBe("epic");
    expect(serviceForUrl("https://rewards.microsoft.com/")).toBe("microsoft");
    expect(serviceForUrl("https://www.bing.com/")).toBe("microsoft");
    expect(serviceForUrl("https://gaming.amazon.com/home")).toBe("primegaming");
  });
  it("returns null for unknown hosts and garbage", () => {
    expect(serviceForUrl("https://example.com/")).toBeNull();
    expect(serviceForUrl("not a url")).toBeNull();
  });
});

describe("toNetscape", () => {
  it("emits a header and a 7-field tab-separated line", () => {
    const out = toNetscape([
      { domain: ".twitch.tv", path: "/", secure: true, expirationDate: 1900000000, name: "a", value: "b", httpOnly: false },
    ]);
    expect(out).toContain("# Netscape HTTP Cookie File");
    const line = out.trim().split("\n").at(-1);
    expect(line).toBe(".twitch.tv\tTRUE\t/\tTRUE\t1900000000\ta\tb");
  });

  it("prefixes HttpOnly cookies with #HttpOnly_ (round-trips the flag)", () => {
    const out = toNetscape([
      { domain: ".twitch.tv", path: "/", secure: true, expirationDate: 1900000000, name: "auth-token", value: "secret", httpOnly: true },
    ]);
    expect(out).toContain("#HttpOnly_.twitch.tv\tTRUE\t/\tTRUE\t1900000000\tauth-token\tsecret");
  });

  it("writes 0 expiry for session cookies", () => {
    const out = toNetscape([{ domain: "twitch.tv", path: "/", secure: false, session: true, name: "s", value: "1" }]);
    expect(out.trim().split("\n").at(-1)).toBe("twitch.tv\tFALSE\t/\tFALSE\t0\ts\t1");
  });
});

describe("dedupeCookies", () => {
  it("removes duplicates by name+domain+path", () => {
    const c = { name: "a", domain: "twitch.tv", path: "/", value: "1" };
    expect(dedupeCookies([c, { ...c }, { ...c, name: "b" }])).toHaveLength(2);
  });
});

describe("SERVICES", () => {
  it("covers every connector", () => {
    expect(SERVICES.map((s) => s.id).sort()).toEqual(["epic", "microsoft", "primegaming", "twitch"]);
  });
});
