import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pairing hand-off, end to end at the route level: mint, redeem, and the status the page
 * waits on.
 *
 * The regression this pins down: for a service that already had an account, the page treated
 * "an account exists" as "the session arrived", left after two seconds, and nothing was ever
 * sent. The page now waits on the pairing's own status, so every way a redemption can end has to
 * land there — including the ones that used to be a bare 500 with nothing logged.
 */

const db = vi.hoisted(() => ({
  existing: null as null | { id: string },
  failWrites: false,
  replaced: [] as Record<string, unknown>[],
  created: [] as Record<string, unknown>[],
  reenabled: [] as string[],
}));

const auth = vi.hoisted(() => ({ signedIn: true }));

vi.mock("@uc/db", () => ({
  getService: async (_db: unknown, id: string) => ({ id }),
  hasConsent: async () => true,
  getAccountByService: async () => db.existing,
  replaceAccountSecret: async (_db: unknown, id: string, values: Record<string, unknown>) => {
    if (db.failWrites) throw new Error("connection terminated");
    db.replaced.push({ id, ...values });
  },
  createAccount: async (_db: unknown, values: Record<string, unknown>) => {
    if (db.failWrites) throw new Error("connection terminated");
    db.created.push(values);
    return { id: "new", ...values };
  },
  reenableConnector: async (_db: unknown, serviceId: string) => {
    db.reenabled.push(serviceId);
  },
}));

vi.mock("@/server/context", () => ({
  getDb: () => ({ db: {} }),
  getMasterKey: () => Buffer.alloc(32, 7),
}));

vi.mock("@/server/session-cookie", () => ({
  isAuthenticated: () => auth.signedIn,
}));

const { POST: mint } = await import("../src/app/api/connect/pair/route.js");
const { GET: status } = await import("../src/app/api/connect/pair/[id]/route.js");
const { POST: redeem } = await import("../src/app/api/connect/session/route.js");
const { resetPairings } = await import("../src/server/pairing.js");
const { resetRateLimits } = await import("../src/server/rate-limit.js");

const COOKIES = [
  "# Netscape HTTP Cookie File",
  ".epicgames.com\tTRUE\t/\tTRUE\t1900000000\tEPIC_SSO\tsecret-value",
  ".epicgames.com\tTRUE\t/\tTRUE\t1900000000\tEPIC_BEARER_TOKEN\tanother-secret",
].join("\n");

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function mintFor(serviceId: string): Promise<{ token: string; pairingId: string }> {
  const res = await mint(post("http://instance/api/connect/pair", { serviceId, config: {} }));
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; pairingId: string };
}

async function statusOf(pairingId: string) {
  const res = status(new Request(`http://instance/api/connect/pair/${pairingId}`), {
    params: { id: pairingId },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  resetPairings();
  resetRateLimits();
  db.existing = null;
  db.failWrites = false;
  db.replaced = [];
  db.created = [];
  db.reenabled = [];
  auth.signedIn = true;
});

describe("minting", () => {
  it("returns a pairing id alongside the token, and the id is not the token", async () => {
    const { token, pairingId } = await mintFor("epic");
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(pairingId).toBeTruthy();
    expect(pairingId).not.toBe(token);
  });

  it("answers 401 with a reason when signed out, rather than a bare 500", async () => {
    auth.signedIn = false;
    const res = await mint(post("http://instance/api/connect/pair", { serviceId: "epic" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });
});

describe("the status the page waits on", () => {
  it("stays pending for an existing account until something is actually sent", async () => {
    // The exact case that used to bounce the page to the dashboard: the account row exists.
    db.existing = { id: "acc-1" };
    const { pairingId } = await mintFor("primegaming");
    const { body } = await statusOf(pairingId);
    expect(body.state).toBe("pending");
  });

  it("reports a reconnect as connected, with what arrived and never the values", async () => {
    db.existing = { id: "acc-1" };
    const { token, pairingId } = await mintFor("epic");

    const res = await redeem(post("http://instance/api/connect/session", { token, cookiesText: COOKIES }));
    expect(res.status).toBe(200);

    const { res: statusRes, body } = await statusOf(pairingId);
    expect(body).toEqual({
      state: "connected",
      serviceId: "epic",
      reconnected: true,
      cookieCount: 2,
      hosts: ["epicgames.com"],
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret-value");
    expect(raw).not.toContain(token);
    expect(statusRes.headers.get("cache-control")).toBe("no-store");
    // Status is for the operator's own page only.
    expect(statusRes.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports a refused payload as failed, with the reason the page shows", async () => {
    const { token, pairingId } = await mintFor("primegaming");
    const res = await redeem(
      post("http://instance/api/connect/session", { token, cookiesText: "# only a comment" }),
    );
    expect(res.status).toBe(422);
    const { body } = await statusOf(pairingId);
    expect(body.state).toBe("failed");
    expect((body.error as { message: string }).message).toMatch(/no valid cookies/i);
  });

  it("reports a storage failure as failed instead of a bare 500 nobody sees", async () => {
    db.existing = { id: "acc-1" };
    db.failWrites = true;
    const { token, pairingId } = await mintFor("epic");
    const res = await redeem(post("http://instance/api/connect/session", { token, cookiesText: COOKIES }));
    expect(res.status).toBe(500);
    // With CORS, so the extension sees the message rather than a network error.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INTERNAL");
    const { body } = await statusOf(pairingId);
    expect(body.state).toBe("failed");
  });

  it("answers 404 for a pairing it does not know, as after a restart", async () => {
    const { res, body } = await statusOf("not-a-pairing");
    expect(res.status).toBe(404);
    expect(body.state).toBe("unknown");
  });

  it("requires the operator's session", async () => {
    const { pairingId } = await mintFor("epic");
    auth.signedIn = false;
    const { res } = await statusOf(pairingId);
    expect(res.status).toBe(401);
  });
});

describe("redemption", () => {
  it("replaces only the session on a reconnect, keeping the proxy and fingerprint", async () => {
    // This path has no proxy field. It used to write null for one, silently erasing whatever the
    // operator had configured, and reset the browser fingerprint the session was used with.
    db.existing = { id: "acc-1" };
    const { token } = await mintFor("epic");
    await redeem(post("http://instance/api/connect/session", { token, cookiesText: COOKIES }));

    expect(db.replaced).toHaveLength(1);
    const values = db.replaced[0]!;
    expect(values).not.toHaveProperty("proxyCiphertext");
    expect(values).not.toHaveProperty("proxyDataKey");
    expect(values).not.toHaveProperty("fingerprint");
    expect(db.reenabled).toEqual(["epic"]);
  });

  it("creates a new account with a fingerprint and no proxy", async () => {
    const { token } = await mintFor("epic");
    const res = await redeem(post("http://instance/api/connect/session", { token, cookiesText: COOKIES }));
    expect(res.status).toBe(201);
    expect(db.created).toHaveLength(1);
    expect(db.created[0]).toHaveProperty("fingerprint");
    expect(db.created[0]!.proxyCiphertext).toBeNull();
  });

  it("is single-use", async () => {
    const { token } = await mintFor("epic");
    await redeem(post("http://instance/api/connect/session", { token, cookiesText: COOKIES }));
    const again = await redeem(post("http://instance/api/connect/session", { token, cookiesText: COOKIES }));
    expect(again.status).toBe(401);
  });

  it("does not accept the pairing id in place of the token", async () => {
    const { pairingId } = await mintFor("epic");
    const res = await redeem(
      post("http://instance/api/connect/session", { token: pairingId, cookiesText: COOKIES }),
    );
    expect(res.status).toBe(401);
  });
});
