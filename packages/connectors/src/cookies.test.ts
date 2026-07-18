import { describe, expect, it } from "vitest";
import { parseCookiesJson, parseCookiesTxt } from "./cookies.js";

describe("parseCookiesTxt", () => {
  it("parses standard Netscape lines", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      "store.epicgames.com\tFALSE\t/\tTRUE\t1893456000\tEPIC_SSO\tabc123",
      "",
    ].join("\n");
    const cookies = parseCookiesTxt(txt);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: "EPIC_SSO",
      value: "abc123",
      domain: "store.epicgames.com",
      path: "/",
      secure: true,
      expires: 1893456000,
    });
  });

  it("honors the #HttpOnly_ prefix and skips comments", () => {
    const txt = [
      "# a comment",
      "#HttpOnly_.epicgames.com\tTRUE\t/\tTRUE\t0\tSESSION\tzzz",
    ].join("\n");
    const cookies = parseCookiesTxt(txt);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: "SESSION", httpOnly: true, domain: ".epicgames.com" });
    // expiry 0 → treated as session cookie (no expires field)
    expect(cookies[0]!.expires).toBeUndefined();
  });

  it("ignores malformed lines", () => {
    expect(parseCookiesTxt("not\ttabbed\tenough")).toHaveLength(0);
  });
});

describe("parseCookiesJson", () => {
  it("parses a JSON cookie array", () => {
    const json = JSON.stringify([
      { name: "a", value: "1", domain: "x.com", path: "/", secure: true },
    ]);
    const cookies = parseCookiesJson(json);
    expect(cookies[0]).toMatchObject({ name: "a", value: "1", domain: "x.com", secure: true });
  });

  it("throws on non-array or missing fields", () => {
    expect(() => parseCookiesJson('{"name":"a"}')).toThrow(/array/);
    expect(() => parseCookiesJson('[{"value":"1"}]')).toThrow(/name\/value/);
  });
});
