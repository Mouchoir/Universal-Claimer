// The checkout's frame reading and clicks in a real Chromium, against local stand-ins of Epic's
// pages. Opt-in: it runs when EPIC_BROWSER_TESTS is set and a browser is at hand, and skips itself
// otherwise, so the default run never needs one.
//
// What a fake page cannot answer is what this is for: whether the invisible hCaptcha really reads
// as not showing, whether a hidden PIN form is really hidden to the reader, and how Playwright
// itself matches a button's name. The stand-ins are served under Epic's own addresses by routing
// every request, so frames are classified exactly as on the store, and nothing reaches the network.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { buttonName, readFrame, type CheckoutTiming } from "../src/epic/checkout.js";
import { PlaywrightEpicDriver, SIGN_IN_TIMING } from "../src/epic/driver.js";
import type { SessionHandle } from "../src/connector.js";

/**
 * A Chromium that is already on this machine; never one downloaded for the test. EPIC_BROWSER_PATH
 * first, then the CloakBrowser binary the worker runs (once it has fetched it), then Playwright's
 * own Chromium.
 */
async function findBrowser(): Promise<string | undefined> {
  if (!process.env.EPIC_BROWSER_TESTS) return undefined;
  const given = process.env.EPIC_BROWSER_PATH;
  if (given) return existsSync(given) ? given : undefined;
  try {
    const { binaryInfo } = await import("cloakbrowser");
    const info = binaryInfo();
    if (info.installed && existsSync(info.binaryPath)) return info.binaryPath;
  } catch {
    // No CloakBrowser binary; Playwright's Chromium may still be there.
  }
  try {
    const path = chromium.executablePath();
    if (path && existsSync(path)) return path;
  } catch {
    // Playwright has no Chromium of its own installed either.
  }
  return undefined;
}

const browserPath = await findBrowser();

const PRODUCT = "https://store.epicgames.com/en-US/p/stand-in";
const PURCHASE = "https://www.epicgames.com/store/purchase?offers=stand-in";
const HCAPTCHA = "https://newassets.hcaptcha.com/captcha/v1/stand-in/static/hcaptcha.html";

/** Pages keyed by host and path; a request for anything else is refused, never sent. */
type StandIns = (url: URL) => string | undefined;

/**
 * Route every request of the context to the stand-ins. `/__stand-in/event?name=...` on any host
 * is how a stand-in page reports what was clicked in it.
 */
async function serve(context: BrowserContext, pages: StandIns, events: string[] = []) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/__stand-in/event") {
      events.push(url.searchParams.get("name") ?? "");
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.hostname === "newassets.hcaptcha.com") {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>challenge</p>" });
    }
    const html = pages(url);
    if (html === undefined) return route.abort();
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  });
  return events;
}

const doc = (body: string) => `<!doctype html><html lang="en"><body>${body}</body></html>`;

/**
 * hCaptcha as Epic's checkout carries it: the invisible checkbox frame, never shown, and the
 * challenge frame parked off-screen with `visibility: hidden` until a challenge is set - which
 * still gives it a box, so only the visibility says it is not showing.
 */
function hcaptcha(showing: boolean): string {
  const parked = showing
    ? "visibility: visible; position: absolute; top: 20px; left: 20px; opacity: 1"
    : "visibility: hidden; position: absolute; top: -10000px; left: 0; opacity: 0";
  return `
    <div id="h_captcha_challenge_checkout_free_prod">
      <iframe src="${HCAPTCHA}#frame=checkbox-invisible" style="display: none"></iframe>
      <div style="${parked}">
        <iframe src="${HCAPTCHA}#frame=challenge&id=0" title="Main content of the hCaptcha challenge"
          style="border: 0; position: relative; width: 400px; height: 600px"></iframe>
      </div>
    </div>`;
}

const cookieBanner = `
  <div id="cookie-banner" role="dialog" aria-label="Cookie consent">
    <p>This site uses cookies.</p>
    <button id="cookies-accept">Accept All Cookies</button>
  </div>`;

const eulaDialog = `
  <div role="dialog" aria-modal="true" id="eula">
    <h2>End User License Agreement</h2>
    <label><input type="checkbox" id="agree"> I have read and agree</label>
    <button id="eula-accept">Accept</button>
  </div>`;

describe.skipIf(!browserPath)("readCheckoutView in a real Chromium", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** Serve `body` as the purchase window, let its frames load, and read it as the walk does. */
  async function read(body: string) {
    const context = await browser.newContext({ locale: "en-US" });
    try {
      await serve(context, (u) => (u.hostname === "www.epicgames.com" ? doc(body) : undefined));
      const page = await context.newPage();
      await page.goto(PURCHASE, { waitUntil: "load" });
      return await readFrame(page.mainFrame());
    } finally {
      await context.close();
    }
  }

  const confirm = `<button class="payment-btn">Add to library</button>`;

  it("the invisible hCaptcha Epic's checkout always loads is not a challenge", async () => {
    const view = await read(confirm + hcaptcha(false));
    expect(view).toBeDefined();
    expect(view!.captcha).toBe(false);
  }, 30_000);

  it("a challenge that is showing is one", async () => {
    expect((await read(confirm + hcaptcha(true)))!.captcha).toBe(true);
  }, 30_000);

  it("a parental-controls PIN form that is there but hidden is not asked for; a shown one is", async () => {
    const pin = (hidden: boolean) =>
      `<div class="payment-pin-code"${hidden ? ' style="display: none"' : ""}>
        <label>Parental controls PIN <input type="text" inputmode="numeric" maxlength="4"></label>
      </div>`;
    expect((await read(confirm + pin(true)))!.pin).toBe(false);
    expect((await read(confirm + pin(false)))!.pin).toBe(true);
  }, 30_000);

  it("confirmation copy counts from what shows, not from a script or hidden text", async () => {
    const script = `<script>window.__copy = { done: "Thanks for your order!" };</script>`;
    const hidden = `<div hidden>Thanks for your order!</div>`;
    expect((await read(confirm + script))!.confirmed).toBe(false);
    expect((await read(confirm + hidden))!.confirmed).toBe(false);
    // Before the confirm click, shown next to the button: the reader reports it, and it is the
    // walk's job not to take it for the outcome (the driver suite below).
    const before = await read(`<p>Download the Epic Games Launcher to play</p>${confirm}`);
    expect(before!.confirmed).toBe(true);
    expect(before!.buttons.map((b) => b.label)).toEqual(["Add to library"]);
  }, 30_000);

  it("a cookie banner before a EULA: both read in page order, the EULA's box not ticked", async () => {
    const view = await read(cookieBanner + eulaDialog);
    expect(view!.eula).toBe(true);
    expect(view!.buttons.map((b) => [b.label, b.inDialog])).toEqual([
      ["Accept All Cookies", true],
      ["Accept", true],
    ]);
  }, 30_000);

  it("Playwright takes a string name as a substring, and buttonName does not", async () => {
    const context = await browser.newContext({ locale: "en-US" });
    try {
      await serve(context, (u) =>
        u.hostname === "store.epicgames.com" ? doc(cookieBanner + eulaDialog) : undefined,
      );
      const page = await context.newPage();
      await page.goto(PRODUCT, { waitUntil: "load" });
      const byString = page.getByRole("button", { name: "Accept" }).first();
      const byName = page.getByRole("button", { name: buttonName("Accept") }).first();
      expect(await byString.getAttribute("id")).toBe("cookies-accept");
      expect(await byName.getAttribute("id")).toBe("eula-accept");
    } finally {
      await context.close();
    }
  }, 30_000);
});

// Real-browser budgets: long enough for a page to react, short enough for a test.
const QUICK: CheckoutTiming = {
  ctaSettleMs: 2_000,
  settleMs: 300,
  openMs: 5_000,
  confirmMs: 5_000,
  outcomeMs: 3_000,
  verifyTries: 2,
  verifyGapMs: 300,
  pollMs: 100,
};

describe.skipIf(!browserPath)("PlaywrightEpicDriver checkout in a real Chromium", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /**
   * A product page and its purchase window. The page reads "In Library" once the window has
   * placed an order; with `eula`, a cookie banner sits on the page from the start and the EULA
   * dialog comes up behind it on the click, before the window. With `hint`, the window shows a
   * line of Epic's post-order copy from the moment it opens.
   */
  async function store(opts: { eula?: boolean; hint?: boolean }) {
    const context = await browser.newContext({ locale: "en-US" });
    const events: string[] = [];
    const product = () =>
      doc(`
        ${opts.eula ? cookieBanner : ""}
        <main>
          <h1>Stand-in Game</h1>
          <button data-testid="purchase-cta-button">${events.includes("order") ? "In Library" : "Get"}</button>
        </main>
        <div id="modal-root"></div>
        <script>
          const ev = (name) => fetch("/__stand-in/event?name=" + encodeURIComponent(name));
          const root = document.getElementById("modal-root");
          const openWindow = () => {
            const frame = document.createElement("iframe");
            frame.src = ${JSON.stringify(PURCHASE)};
            frame.style = "width: 800px; height: 600px; border: 0";
            root.append(frame);
          };
          document.getElementById("cookies-accept")?.addEventListener("click", () => {
            ev("cookies-accepted");
            document.getElementById("cookie-banner").remove();
          });
          document.querySelector("[data-testid=purchase-cta-button]").addEventListener("click", () => {
            ev("get");
            if (!${opts.eula === true}) return openWindow();
            root.insertAdjacentHTML("beforeend", ${JSON.stringify(eulaDialog)});
            document.getElementById("eula-accept").addEventListener("click", () => {
              if (!document.getElementById("agree").checked) return;
              ev("eula-accepted");
              document.getElementById("eula").remove();
              openWindow();
            });
          });
        </script>`);
    const purchase = () =>
      doc(`
        <div id="summary">
          ${opts.hint ? "<p>Download the Epic Games Launcher to play</p>" : ""}
          <button id="place" class="payment-btn">Add to library</button>
        </div>
        <div id="processing" hidden>Processing your order</div>
        <div id="done" hidden><h2>Thanks for your order!</h2></div>
        <script>
          document.getElementById("place").addEventListener("click", async () => {
            document.getElementById("summary").remove();
            document.getElementById("processing").hidden = false;
            await fetch("/__stand-in/event?name=order");
            setTimeout(() => {
              document.getElementById("processing").hidden = true;
              document.getElementById("done").hidden = false;
            }, 300);
          });
        </script>`);
    await serve(
      context,
      (u) => {
        if (u.hostname === "store.epicgames.com" && u.pathname === "/en-US/p/stand-in") return product();
        if (u.hostname === "www.epicgames.com" && u.pathname === "/store/purchase") return purchase();
        return undefined;
      },
      events,
    );
    await context.newPage();
    const session = { context } as unknown as SessionHandle;
    const driver = new PlaywrightEpicDriver(session, SIGN_IN_TIMING, QUICK);
    return { driver, events, close: () => context.close() };
  }

  const game = { title: "Stand-in Game", url: PRODUCT };

  it("ticks the EULA's box and clicks its Accept, never the cookie banner's Accept All Cookies", async () => {
    const s = await store({ eula: true });
    try {
      expect(await s.driver.claimGame(game)).toEqual({ claimed: true });
      expect(s.events).toEqual(["get", "eula-accepted", "order"]);
    } finally {
      await s.close();
    }
  }, 60_000);

  it("clicks the confirm button even when the window opens with post-order copy already in it", async () => {
    const s = await store({ hint: true });
    try {
      expect(await s.driver.claimGame(game)).toEqual({ claimed: true });
      expect(s.events).toEqual(["get", "order"]);
    } finally {
      await s.close();
    }
  }, 60_000);
});
