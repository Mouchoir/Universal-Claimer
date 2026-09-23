// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExtensionSetup } from "../src/app/connect/[id]/ExtensionSetup.js";

/**
 * The one-click setup card, against a fake instance.
 *
 * The regression this exists for: on a reconnect the card declared success as soon as an account
 * existed for the service — which it already did — so it left for the dashboard two seconds in,
 * before the extension had sent anything, and without a word. It must now wait for the pairing's
 * own outcome and say what that outcome was.
 */

const POLL = 20;
const TOKEN = "t".repeat(43);
const PAIRING_ID = "pairing-id";

type Status = { status: number; body: unknown };

/** A fake instance: the mint answer, then a queue of status answers (the last one repeats). */
function fakeInstance(opts: { mint?: Status; statuses: Status[] }) {
  const statuses = [...opts.statuses];
  const polls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/connect/pair") {
      const m = opts.mint ?? { status: 200, body: { token: TOKEN, pairingId: PAIRING_ID } };
      return new Response(JSON.stringify(m.body), { status: m.status });
    }
    if (url.startsWith("/api/connect/pair/")) {
      polls.push(url);
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return new Response(JSON.stringify(s.body), { status: s.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { polls };
}

const pending: Status = { status: 200, body: { state: "pending", serviceId: "primegaming" } };

function setup() {
  const onConnected = vi.fn();
  render(
    <ExtensionSetup serviceId="primegaming" config={{}} onConnected={onConnected} pollMs={POLL} />,
  );
  return { onConnected };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/connect/primegaming");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("without the page bridge", () => {
  it("keeps waiting, with the pairing in the URL, while nothing has been sent", async () => {
    const { polls } = fakeInstance({ statuses: [pending] });
    const { onConnected } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    // Several polls go by, all pending: the card must neither leave nor drop the pairing.
    await waitFor(() => expect(polls.length).toBeGreaterThanOrEqual(5));
    expect(onConnected).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get("pair")).toBe(TOKEN);
    expect(screen.getByText(/Send to this instance/)).toBeTruthy();
    expect(polls[0]).toBe(`/api/connect/pair/${PAIRING_ID}`);
  });

  it("moves on only once the instance reports the session stored, and says what arrived", async () => {
    fakeInstance({
      statuses: [
        pending,
        pending,
        {
          status: 200,
          body: {
            state: "connected",
            serviceId: "primegaming",
            reconnected: true,
            cookieCount: 12,
            hosts: ["amazon.fr"],
          },
        },
      ],
    });
    const { onConnected } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    await screen.findByText(/Reconnected\./);
    expect(screen.getByText(/12 cookies received/)).toBeTruthy();
    expect(screen.getByText(/amazon\.fr/)).toBeTruthy();
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    // Spent, so it no longer belongs in the address bar.
    expect(new URL(window.location.href).searchParams.get("pair")).toBeNull();
  });

  it("shows the instance's reason when it refuses the session", async () => {
    fakeInstance({
      statuses: [
        pending,
        {
          status: 200,
          body: {
            state: "failed",
            serviceId: "primegaming",
            error: { code: "AUTH_FAILED", message: "No valid cookies were provided." },
          },
        },
      ],
    });
    const { onConnected } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /refused the session: No valid cookies were provided\./,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("says the instance restarted when it no longer knows the pairing", async () => {
    fakeInstance({ statuses: [pending, { status: 404, body: { state: "unknown" } }] });
    setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/probably restarted/);
  });

  it("says when the window closed with nothing sent", async () => {
    fakeInstance({ statuses: [{ status: 200, body: { state: "expired", serviceId: "x" } }] });
    setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/expired before the extension/);
  });

  it("says so when the operator has been signed out", async () => {
    fakeInstance({ mint: { status: 401, body: { error: { code: "UNAUTHENTICATED" } } }, statuses: [pending] });
    setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/signed out/);
  });
});

describe("with the page bridge", () => {
  /** Stand in for the extension's content script on this page. */
  function fakeBridge(reply: (message: { token: string; serviceId: string }) => unknown) {
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, origin: window.location.origin, source: window }),
      );
    vi.spyOn(window, "postMessage").mockImplementation(((data: { type?: string; token?: string; serviceId?: string }) => {
      if (data?.type === "uc-extension-ready?") setTimeout(() => send({ type: "uc-extension-ready" }));
      if (data?.type === "uc-extension-connect") {
        setTimeout(() =>
          send({
            type: "uc-extension-result",
            ...(reply({ token: data.token!, serviceId: data.serviceId! }) as object),
          }),
        );
      }
    }) as typeof window.postMessage);
  }

  it("explains a missing permission and keeps waiting, instead of leaving", async () => {
    const { polls } = fakeInstance({ statuses: [pending] });
    fakeBridge(() => ({ ok: false, needsAccess: true, service: "Prime Gaming", domains: ["amazon.fr"] }));
    const { onConnected } = setup();

    const button = await screen.findByRole("button", { name: "Connect primegaming now" });
    await userEvent.click(button);

    await screen.findByText(/needs your permission first/);
    const before = polls.length;
    await act(() => new Promise((r) => setTimeout(r, POLL * 6)));
    expect(polls.length).toBeGreaterThan(before);
    expect(onConnected).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get("pair")).toBe(TOKEN);
  });

  it("relays the pairing the page was issued, and finishes when the instance confirms", async () => {
    fakeInstance({
      statuses: [
        pending,
        {
          status: 200,
          body: { state: "connected", serviceId: "primegaming", reconnected: false, cookieCount: 4, hosts: [] },
        },
      ],
    });
    const relayed: { token: string; serviceId: string }[] = [];
    fakeBridge((m) => {
      relayed.push(m);
      return { ok: true };
    });
    const { onConnected } = setup();

    await userEvent.click(await screen.findByRole("button", { name: "Connect primegaming now" }));

    await screen.findByText(/Connected\./);
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(relayed).toEqual([{ token: TOKEN, serviceId: "primegaming" }]);
  });
});

describe("a session that arrived with a warning", () => {
  it("stays on the page and says why, instead of leaving for the dashboard", async () => {
    fakeInstance({
      statuses: [
        {
          status: 200,
          body: {
            state: "connected",
            serviceId: "primegaming",
            reconnected: true,
            cookieCount: 28,
            hosts: ["amazon.fr"],
            signedInOn: [],
            warnings: ["No Amazon sign-in was found in this session."],
          },
        },
      ],
    });
    const { onConnected } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Set up with the extension" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/No Amazon sign-in/);
    await act(() => new Promise((r) => setTimeout(r, POLL * 5)));
    expect(onConnected).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Go to the dashboard" }));
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
