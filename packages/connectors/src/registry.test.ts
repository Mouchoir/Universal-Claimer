import { describe, expect, it } from "vitest";
import type { Connector } from "./connector.js";
import { ConnectorRegistry } from "./registry.js";

const stub = (id: string): Connector => ({
  id,
  version: "0.0.1",
  methods: ["session_import"],
  authenticate: async () => ({
    ok: true,
    fingerprint: {
      userAgent: "ua",
      timezoneId: "UTC",
      locale: "en-US",
      viewport: { width: 1, height: 1 },
    },
  }),
  claim: async () => ({ outcome: "nothing_to_claim", summary: "" }),
  healthCheck: async () => ({ healthy: true }),
});

describe("ConnectorRegistry", () => {
  it("registers and resolves connectors by id", () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("epic"));
    expect(reg.require("epic").id).toBe("epic");
    expect(reg.ids()).toEqual(["epic"]);
  });

  it("throws on duplicate registration and unknown id", () => {
    const reg = new ConnectorRegistry();
    reg.register(stub("epic"));
    expect(() => reg.register(stub("epic"))).toThrow(/already registered/);
    expect(() => reg.require("nope")).toThrow(/Unknown connector/);
    expect(reg.get("nope")).toBeUndefined();
  });
});
