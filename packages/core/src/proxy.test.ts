import { describe, expect, it } from "vitest";
import { isValidProxyUrl, maskProxy } from "./proxy.js";

describe("isValidProxyUrl", () => {
  it("accepts supported schemes with host + port", () => {
    expect(isValidProxyUrl("http://host:8080")).toBe(true);
    expect(isValidProxyUrl("https://user:pass@host:3128")).toBe(true);
    expect(isValidProxyUrl("socks5://10.0.0.1:1080")).toBe(true);
  });

  it("rejects missing port, bad scheme, or garbage", () => {
    expect(isValidProxyUrl("http://host")).toBe(false); // no port
    expect(isValidProxyUrl("ftp://host:21")).toBe(false); // bad scheme
    expect(isValidProxyUrl("not a url")).toBe(false);
    expect(isValidProxyUrl("")).toBe(false);
  });
});

describe("maskProxy", () => {
  it("strips credentials, keeping scheme://host:port", () => {
    expect(maskProxy("http://user:pass@host:8080")).toBe("http://host:8080");
    expect(maskProxy("socks5://10.0.0.1:1080")).toBe("socks5://10.0.0.1:1080");
  });

  it("does not leak the password", () => {
    expect(maskProxy("https://bob:s3cr3t@proxy:3128")).not.toContain("s3cr3t");
  });
});
