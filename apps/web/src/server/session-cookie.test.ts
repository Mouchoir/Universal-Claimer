import { afterEach, describe, expect, it } from "vitest";
import { isSecureRequest } from "./session-cookie.js";

/**
 * The rule that decides whether the session cookie carries `Secure`. Getting this wrong is not a
 * visible failure: the browser discards the cookie without a word, sign-in returns 200, and the
 * operator is bounced back to the login form with nothing to go on. Hence the coverage.
 */

const original = process.env.SESSION_COOKIE_SECURE;
afterEach(() => {
  if (original === undefined) delete process.env.SESSION_COOKIE_SECURE;
  else process.env.SESSION_COOKIE_SECURE = original;
});

const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("isSecureRequest", () => {
  it("is off for a plain-HTTP LAN deployment", () => {
    // The regression this exists for: NODE_ENV=production in the image plus http:// on a NAS.
    expect(isSecureRequest(request("http://192.168.1.69:8095/api/auth/login"))).toBe(false);
  });

  it("is on when the request itself is HTTPS", () => {
    expect(isSecureRequest(request("https://claimer.example/api/auth/login"))).toBe(true);
  });

  it("trusts x-forwarded-proto over the connection a proxy terminated", () => {
    expect(
      isSecureRequest(request("http://app:8080/api/auth/login", { "x-forwarded-proto": "https" })),
    ).toBe(true);
  });

  it("reads only the first hop of a multi-hop x-forwarded-proto", () => {
    expect(
      isSecureRequest(
        request("http://app:8080/api/auth/login", { "x-forwarded-proto": "https, http" }),
      ),
    ).toBe(true);
    expect(
      isSecureRequest(
        request("http://app:8080/api/auth/login", { "x-forwarded-proto": "http, https" }),
      ),
    ).toBe(false);
  });

  it("tolerates casing and padding in the forwarded header", () => {
    expect(
      isSecureRequest(request("http://app:8080/x", { "x-forwarded-proto": "  HTTPS " })),
    ).toBe(true);
  });

  it("lets the environment force the flag either way", () => {
    process.env.SESSION_COOKIE_SECURE = "true";
    expect(isSecureRequest(request("http://192.168.1.69:8095/x"))).toBe(true);

    process.env.SESSION_COOKIE_SECURE = "false";
    expect(isSecureRequest(request("https://claimer.example/x"))).toBe(false);
  });

  it("ignores an override that is not exactly true or false", () => {
    process.env.SESSION_COOKIE_SECURE = "yes";
    expect(isSecureRequest(request("https://claimer.example/x"))).toBe(true);
    expect(isSecureRequest(request("http://192.168.1.69:8095/x"))).toBe(false);
  });
});
