import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const validKey = randomBytes(32).toString("base64");

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const cfg = loadConfig({
      APP_ENCRYPTION_KEY: validKey,
      DATABASE_URL: "postgres://user:pass@localhost:5432/uc",
      PORT: "8080",
    } as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(8080);
    expect(cfg.NODE_ENV).toBe("development");
  });

  it("defaults PORT when omitted", () => {
    const cfg = loadConfig({
      APP_ENCRYPTION_KEY: validKey,
      DATABASE_URL: "postgres://localhost/uc",
    } as NodeJS.ProcessEnv);
    expect(cfg.PORT).toBe(8080);
  });

  it("throws with a readable message when required values are missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it("rejects a non-URL DATABASE_URL", () => {
    expect(() =>
      loadConfig({ APP_ENCRYPTION_KEY: validKey, DATABASE_URL: "not-a-url" } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });
});
