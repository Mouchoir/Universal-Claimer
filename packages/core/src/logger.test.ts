import { describe, expect, it } from "vitest";
import { createLogger, redact, REDACTED } from "./logger.js";

describe("redact", () => {
  it("redacts secret-looking keys", () => {
    const out = redact({
      email: "a@b.com",
      password: "hunter2",
      totpSeed: "ABC",
      nested: { cookie: "c", label: "keep" },
    }) as Record<string, any>;
    expect(out.email).toBe("a@b.com");
    expect(out.password).toBe(REDACTED);
    expect(out.totpSeed).toBe(REDACTED);
    expect(out.nested.cookie).toBe(REDACTED);
    expect(out.nested.label).toBe("keep");
  });

  it("redacts Buffers and arrays of secrets", () => {
    const out = redact({ credentials: [{ token: "t" }], blob: Buffer.from("x") }) as Record<
      string,
      any
    >;
    expect(out.credentials).toBe(REDACTED);
    expect(out.blob).toBe(REDACTED);
  });

  it("handles cycles safely", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe("createLogger", () => {
  it("emits JSON with redacted meta and never leaks secrets", () => {
    const lines: string[] = [];
    const log = createLogger({ name: "test", sink: (l) => lines.push(l), now: () => "T" });
    log.info("connected", { serviceId: "epic", password: "hunter2" });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ time: "T", level: "info", name: "test", msg: "connected" });
    expect(record.meta.serviceId).toBe("epic");
    expect(record.meta.password).toBe(REDACTED);
    expect(lines[0]).not.toContain("hunter2");
  });
});
