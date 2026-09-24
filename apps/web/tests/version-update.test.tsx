// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * "Update now", end to end: the route that decides whether there is anything to install, and the
 * panel that follows the update through.
 *
 * The regression: a dashboard left open overnight offered an update the updater had already
 * installed on its own schedule. Pressing it ran the updater, which found nothing, and the page
 * sat on "Updating…" saying nothing — indistinguishable from a button that does not work.
 */

const feed = vi.hoisted(() => ({
  releases: [] as { version: string; notes: string; publishedAt: string }[],
  stale: false,
}));
const auth = vi.hoisted(() => ({ signedIn: true }));

vi.mock("@/server/release-feed", () => ({
  fetchReleases: async () => ({ releases: feed.releases, stale: feed.stale }),
}));
vi.mock("@/server/session-cookie", () => ({ isAuthenticated: () => auth.signedIn }));

const { POST } = await import("../src/app/api/version/update/route.js");
const { resetRateLimits } = await import("../src/server/rate-limit.js");
const { VersionPanel } = await import("../src/app/dashboard/VersionPanel.js");

const OLD = "v2026.09.22-aaaaaaa";
const NEW = "v2026.09.23-bbbbbbb";
const rel = (version: string) => ({ version, notes: `notes for ${version}`, publishedAt: "" });

describe("POST /api/version/update", () => {
  const env = { ...process.env };
  let webhookCalls = 0;
  let webhook: () => Promise<Response> = async () => new Response(null, { status: 200 });

  beforeEach(() => {
    resetRateLimits();
    auth.signedIn = true;
    feed.stale = false;
    webhookCalls = 0;
    webhook = async () => new Response(null, { status: 200 });
    process.env.APP_VERSION = OLD;
    process.env.UPDATE_WEBHOOK_URL = "http://updater:8080/v1/update";
    process.env.UPDATE_WEBHOOK_METHOD = "GET";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        webhookCalls++;
        return webhook();
      }),
    );
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("says it is already up to date, and does not wake the updater", async () => {
    feed.releases = [rel(OLD)];
    const res = await POST();
    expect(await res.json()).toEqual({ ok: true, upToDate: true, running: OLD });
    expect(webhookCalls).toBe(0);
  });

  it("starts the updater when there is something newer, and names the version to land on", async () => {
    feed.releases = [rel(NEW), rel(OLD)];
    expect(await (await POST()).json()).toEqual({ ok: true, started: true, running: OLD, target: NEW });
    expect(webhookCalls).toBe(1);
  });

  it("answers that the update is under way when the updater holds the request", async () => {
    // Watchtower keeps the request open for its whole run; waiting on it would outlast any proxy.
    feed.releases = [rel(NEW), rel(OLD)];
    webhook = async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    };
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).started).toBe(true);
  });

  it("reports an updater that refused or could not be reached", async () => {
    feed.releases = [rel(NEW), rel(OLD)];
    webhook = async () => new Response(null, { status: 401 });
    expect((await POST()).status).toBe(502);
    webhook = async () => {
      throw new TypeError("fetch failed");
    };
    const body = (await (await POST()).json()) as { error: { code: string } };
    expect(body.error.code).toBe("WEBHOOK_FAILED");
  });

  it("still asks the updater when the release list could not be checked", async () => {
    // Not knowing is not the same as knowing there is nothing: the updater decides by image.
    feed.releases = [];
    feed.stale = true;
    await POST();
    expect(webhookCalls).toBe(1);
  });

  it("answers 401 with a reason when signed out", async () => {
    auth.signedIn = false;
    expect((await POST()).status).toBe(401);
  });
});

describe("VersionPanel", () => {
  type VersionState = {
    running: string;
    available: ReturnType<typeof rel>[];
    unseen: ReturnType<typeof rel>[];
    canUpdate: boolean;
  };
  const behind: VersionState = { running: OLD, available: [rel(NEW)], unseen: [], canUpdate: true };
  const current: VersionState = { running: NEW, available: [], unseen: [], canUpdate: true };

  /** A fake instance: /api/version answers from a script, /api/version/update from `update`. */
  function fakeInstance(opts: {
    versions: (VersionState | "down")[];
    update: { status: number; body?: unknown; html?: boolean } | "drop";
  }) {
    const versions = [...opts.versions];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === "/api/version/update") {
          if (opts.update === "drop") {
            throw new TypeError("NetworkError when attempting to fetch resource.");
          }
          const body = opts.update.html
            ? "<html>Bad Gateway</html>"
            : JSON.stringify(opts.update.body ?? {});
          return new Response(body, { status: opts.update.status });
        }
        if (url === "/api/version") {
          const next = versions.length > 1 ? versions.shift()! : versions[0]!;
          if (next === "down") throw new TypeError("NetworkError when attempting to fetch resource.");
          return new Response(JSON.stringify(next), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    return { calls };
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says so when there was nothing to install, instead of sitting on Updating", async () => {
    fakeInstance({
      versions: [behind, behind, "down"],
      update: { status: 200, body: { ok: true, upToDate: true, running: OLD } },
    });
    const reload = vi.fn();
    render(<VersionPanel watchEveryMs={5} watchForMs={200} reload={reload} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    // Shown from the answer itself, even though the follow-up check fails.
    expect((await screen.findByRole("status")).textContent).toMatch(/Already up to date/);
    expect(screen.queryByRole("button", { name: /Updating/ })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads a page left open on an older build when it turns out to be current already", async () => {
    // The incident: the updater had installed the new version overnight; this tab predated it.
    fakeInstance({
      versions: [behind, current],
      update: { status: 200, body: { ok: true, upToDate: true, running: NEW } },
    });
    const reload = vi.fn();
    render(<VersionPanel watchEveryMs={5} watchForMs={200} reload={reload} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("follows the restart and reloads onto the new version", async () => {
    fakeInstance({ versions: [behind, behind, "down", "down", current], update: "drop" });
    const reload = vi.fn();
    render(<VersionPanel watchEveryMs={5} watchForMs={2000} reload={reload} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("keeps watching after an answer, since another run may be the one doing the update", async () => {
    // Watchtower answers at once when its lock is held by the scheduled poll; that poll then
    // replaces the container a little later.
    fakeInstance({
      versions: [behind, behind, behind, behind, current],
      update: { status: 200, body: { ok: true, started: true, running: OLD, target: NEW } },
    });
    const reload = vi.fn();
    render(<VersionPanel watchEveryMs={5} watchForMs={2000} reload={reload} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats a proxy's gateway error as the instance going down, not as a refusal", async () => {
    fakeInstance({ versions: [behind, behind, "down", current], update: { status: 504, html: true } });
    const reload = vi.fn();
    render(<VersionPanel watchEveryMs={5} watchForMs={2000} reload={reload} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("stops waiting after its limit, without calling it a failure", async () => {
    fakeInstance({ versions: [behind, behind, "down"], update: "drop" });
    render(<VersionPanel watchEveryMs={5} watchForMs={60} reload={() => undefined} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    expect((await screen.findByRole("alert", {}, { timeout: 2000 })).textContent).toMatch(
      /Still running .* its log says which/,
    );
  });

  it("shows the instance's own refusal", async () => {
    fakeInstance({
      versions: [behind],
      update: {
        status: 502,
        body: { error: { code: "WEBHOOK_FAILED", message: "The update webhook responded 401." } },
      },
    });
    render(<VersionPanel watchEveryMs={5} watchForMs={200} reload={() => undefined} />);

    await userEvent.click(await screen.findByRole("button", { name: "Update now" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/responded 401/);
  });

  it("reloads a tab left open once the version changed underneath it", async () => {
    const { calls } = fakeInstance({ versions: [behind, current], update: "drop" });
    const reload = vi.fn();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now");
    try {
      spy.mockReturnValue(now);
      render(<VersionPanel reload={reload} />);
      await screen.findByRole("button", { name: "Update now" });

      // An hour later the operator comes back to the tab. Restored before waiting: waitFor keeps
      // time with Date.now, and a frozen clock would never let it give up.
      spy.mockReturnValue(now + 60 * 60 * 1000);
      window.dispatchEvent(new Event("focus"));
    } finally {
      spy.mockRestore();
    }

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c === "/api/version")).toHaveLength(2);
  });

  it("does not fetch in a loop", async () => {
    const { calls } = fakeInstance({ versions: [behind], update: "drop" });
    render(<VersionPanel />);
    await screen.findByRole("button", { name: "Update now" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c === "/api/version")).toHaveLength(1);
  });
});
