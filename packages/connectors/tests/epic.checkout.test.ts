import { describe, expect, it } from "vitest";
import { PlaywrightEpicDriver, SIGN_IN_TIMING } from "../src/epic/driver.js";
import {
  CHECKOUT_TIMING,
  buttonName,
  isOwnedLabel,
  walkCheckout,
  type CheckoutButton,
  type CheckoutProbe,
  type CheckoutTiming,
  type CheckoutView,
} from "../src/epic/checkout.js";
import type { SessionHandle } from "../src/connector.js";

// --- The walk itself, against a scripted checkout on a fake clock --------------------------------

function button(label: string, over: Partial<CheckoutButton> = {}): CheckoutButton {
  return { label, enabled: true, busy: false, inDialog: false, ...over };
}

function view(kind: CheckoutView["kind"], over: Partial<CheckoutView> = {}): CheckoutView {
  return {
    id: kind,
    kind,
    buttons: [],
    captcha: false,
    confirmed: false,
    unavailable: false,
    eula: false,
    pin: false,
    cta: kind === "page" ? "Get" : null,
    ...over,
  };
}

/** What the walk did, on the fake clock. */
interface Seen {
  t: number;
  clickedCta?: number;
  pressed: { label: string; at: number }[];
  agreed: number;
  reloads: number;
}

function pressedAt(seen: Seen, label: RegExp): number | undefined {
  return seen.pressed.find((p) => label.test(p.label))?.at;
}

/** A checkout whose frames, ownership and label are scripted against a clock that sleeping advances. */
function scripted(opts: {
  views: (seen: Seen) => CheckoutView[];
  owned?: (seen: Seen) => boolean;
  clickError?: string;
  /** Clicks on these labels do not go through (something covers the button). */
  refuse?: RegExp;
  /** The product page has closed (the browser went away) from this point on. */
  closed?: (seen: Seen) => boolean;
}): { probe: CheckoutProbe; seen: Seen } {
  const seen: Seen = { t: 0, pressed: [], agreed: 0, reloads: 0 };
  const probe: CheckoutProbe = {
    look: async () => opts.views(seen),
    clickCta: async () => {
      if (opts.clickError) return opts.clickError;
      seen.clickedCta = seen.t;
      return undefined;
    },
    press: async (_view, label) => {
      if (opts.refuse?.test(label)) return false;
      seen.pressed.push({ label, at: seen.t });
      return true;
    },
    agree: async () => {
      seen.agreed += 1;
      return true;
    },
    owned: async () => {
      seen.reloads += 1;
      return opts.owned?.(seen) ?? false;
    },
    ctaLabel: async () => "Get",
    closed: () => opts.closed?.(seen) ?? false,
    sleep: async (ms) => {
      seen.t += ms;
    },
    now: () => seen.t,
  };
  return { probe, seen };
}

/**
 * The usual free checkout: the purchase window opens on the click with "Add to library" in it,
 * and Epic confirms `confirmAfter` ms after that is clicked (never, if left out).
 */
function freeCheckout(opts: { confirmAfter?: number; window?: Partial<CheckoutView> } = {}) {
  return (seen: Seen): CheckoutView[] => {
    const page = view("page");
    if (seen.clickedCta === undefined) return [page];
    const at = pressedAt(seen, /add to library/i);
    const confirmed =
      at !== undefined && opts.confirmAfter !== undefined && seen.t - at >= opts.confirmAfter;
    return [
      page,
      view("checkout", { buttons: [button("Add to library")], confirmed, ...opts.window }),
    ];
  };
}

describe("walkCheckout", () => {
  it("waits for a confirmation well past the old fixed 5 s, then finds the game in the library", async () => {
    const confirmAfter = 12_000;
    const { probe, seen } = scripted({
      views: freeCheckout({ confirmAfter }),
      owned: (s) => {
        const at = pressedAt(s, /add to library/i);
        return at !== undefined && s.t - at >= confirmAfter;
      },
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(seen.t - pressedAt(seen, /add to library/i)!).toBeGreaterThanOrEqual(confirmAfter);
    // One reload, and only once Epic had said so.
    expect(seen.reloads).toBe(1);
  });

  it("gives up on the confirmation after its window, not before, and says where it stopped", async () => {
    const { probe, seen } = scripted({ views: freeCheckout() });
    const res = await walkCheckout(probe);
    expect(res).toEqual({
      claimed: false,
      reason:
        "clicked 'Get'; purchase window opened; clicked 'Add to library'; no confirmation within 30 s; " +
        "the purchase button still reads 'Get'",
    });
    const waited = seen.t - pressedAt(seen, /add to library/i)!;
    expect(waited).toBeGreaterThanOrEqual(CHECKOUT_TIMING.outcomeMs);
    expect(waited).toBeLessThan(CHECKOUT_TIMING.outcomeMs + CHECKOUT_TIMING.pollMs * 2);
    // The one reload is the last word, after the wait: a claim whose confirmation copy changed
    // again would still show up as owned there.
    expect(seen.reloads).toBe(1);
  });

  it("re-checks a library that lags the confirmation", async () => {
    const { probe, seen } = scripted({
      views: freeCheckout({ confirmAfter: 0 }),
      owned: (s) => s.reloads >= 2,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(seen.reloads).toBe(2);
  });

  it("a confirmation the library never agrees with is not a claim", async () => {
    const { probe, seen } = scripted({ views: freeCheckout({ confirmAfter: 0 }) });
    const res = await walkCheckout(probe);
    expect(res.claimed).toBe(false);
    expect(res.reason).toContain(
      "clicked 'Add to library'; Epic confirmed the order; the product page did not show it as owned after 3 reloads",
    );
    expect(seen.reloads).toBe(CHECKOUT_TIMING.verifyTries);
  });

  it("takes the purchase button turning to In Library in place as the signal, and verifies it", async () => {
    const { probe, seen } = scripted({
      views: (s) => {
        const at = pressedAt(s, /add to library/i);
        const done = at !== undefined && s.t - at >= 3_000;
        return [
          view("page", { cta: done ? "In Library" : "Get" }),
          ...(s.clickedCta !== undefined && !done
            ? [view("checkout", { buttons: [button("Add to library")] })]
            : []),
        ];
      },
      owned: () => true,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(seen.reloads).toBe(1);
  });

  it("clears the notices in the way, in order, and ends up claiming", async () => {
    const { probe, seen } = scripted({
      views: (s) => {
        const pressed = (re: RegExp) => pressedAt(s, re) !== undefined;
        // A mature-content notice in front of the page until its Continue is clicked.
        const page = view("page", { buttons: pressed(/^continue$/i) ? [] : [button("Continue")] });
        if (s.clickedCta === undefined) return [page];
        const confirmedAt = pressedAt(s, /add to library/i);
        const window = view("checkout", {
          eula: s.agreed === 0,
          buttons: [
            ...(pressed(/^accept$/i) ? [] : [button("Accept")]),
            button("Add to library"),
            // The EU right-of-withdrawal notice, after the confirm click.
            ...(confirmedAt !== undefined && !pressed(/^i accept$/i) ? [button("I Accept")] : []),
          ],
          confirmed: pressed(/^i accept$/i),
        });
        return [page, window];
      },
      owned: () => true,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(seen.agreed).toBe(1);
    expect(seen.pressed.map((p) => p.label)).toEqual([
      "Continue",
      "Accept",
      "Add to library",
      "I Accept",
    ]);
    // Continue came before the purchase button was clicked, not after.
    expect(seen.pressed[0]!.at).toBeLessThan(seen.clickedCta!);
    // The confirm click waited for a fresh look once the EULA was out of the way.
    expect(seen.pressed[2]!.at).toBeGreaterThan(seen.pressed[1]!.at);
  });

  it("never clicks a cookie banner's Accept All, nor an Accept outside a dialog on the page", async () => {
    const { probe, seen } = scripted({
      views: (s) => [
        view("page", {
          buttons: [button("Accept All Cookies", { inDialog: true }), button("Accept")],
        }),
        ...(s.clickedCta !== undefined
          ? [view("checkout", { buttons: [button("Add to library")] })]
          : []),
      ],
    });
    await walkCheckout(probe, { ...CHECKOUT_TIMING, outcomeMs: 1_000 });
    expect(seen.pressed.map((p) => p.label)).toEqual(["Add to library"]);
  });

  it("accepts the EULA on the page itself once its box is ticked, dialog or not", async () => {
    const { probe, seen } = scripted({
      views: (s) => {
        if (s.clickedCta === undefined) return [view("page")];
        if (pressedAt(s, /^accept$/i) === undefined) {
          return [view("page", { eula: s.agreed === 0, buttons: [button("Accept")] })];
        }
        const ordered = pressedAt(s, /add to library/i) !== undefined;
        return [
          view("page"),
          view("checkout", { buttons: [button("Add to library")], confirmed: ordered }),
        ];
      },
      owned: () => true,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(seen.agreed).toBe(1);
    expect(seen.pressed.map((p) => p.label)).toEqual(["Accept", "Add to library"]);
  });

  it("says so when the confirm button looks clickable and the click still does not go through", async () => {
    const { probe } = scripted({ views: freeCheckout(), refuse: /add to library/i });
    const res = await walkCheckout(probe);
    expect(res.reason).toContain(
      "purchase window opened; 'Add to library' stayed unclickable for 30 s",
    );
  });

  it("a placeholder Get that turns to In Library before the click is already owned, and is not clicked", async () => {
    const { probe, seen } = scripted({
      views: (s) => [view("page", { cta: s.t >= CHECKOUT_TIMING.settleMs ? "In Library" : "Get" })],
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: false, alreadyOwned: true });
    expect(seen.clickedCta).toBeUndefined();
  });

  it("a captcha in the purchase window goes to the captcha path at once, before any reload", async () => {
    const { probe, seen } = scripted({ views: freeCheckout({ window: { captcha: true } }) });
    expect(await walkCheckout(probe)).toEqual({
      claimed: false,
      captcha: true,
      reason:
        "clicked 'Get'; purchase window opened; a captcha challenge is showing in the purchase window",
    });
    expect(seen.reloads).toBe(0);
  });

  it("Epic's own failed-captcha message goes to the captcha path too", async () => {
    const { probe } = scripted({
      views: freeCheckout({
        window: { error: "Failed to challenge captcha, please try again later." },
      }),
    });
    expect(await walkCheckout(probe)).toMatchObject({ claimed: false, captcha: true });
  });

  it("quotes an error in the window, without anything that looks like an address or a number", async () => {
    const { probe } = scripted({
      views: freeCheckout({
        window: {
          error: "We could not complete the order for someone@example.com (ref 20260924).",
        },
      }),
    });
    const res = await walkCheckout(probe);
    expect(res.reason).toContain(
      'Epic said "We could not complete the order for [email] (ref [number])."',
    );
    expect(res.reason).not.toContain("someone@");
    expect(res.reason).not.toContain("20260924");
  });

  it("waits for a busy confirm button instead of clicking it, and says when it never came free", async () => {
    const { probe, seen } = scripted({
      views: freeCheckout({ window: { buttons: [button("Add to library", { busy: true })] } }),
    });
    const res = await walkCheckout(probe);
    expect(seen.pressed).toEqual([]);
    expect(res.reason).toContain("purchase window opened; 'Add to library' stayed busy for 30 s");
  });

  it("finds the checkout in a frame outside the usual container by its confirm button", async () => {
    // feldorn/free-games-claimer issue #151: a "Checkout" frame Epic opens on the page itself.
    const { probe, seen } = scripted({
      views: (s) => [
        view("page"),
        ...(s.clickedCta !== undefined
          ? [view("frame", { buttons: [button("Add to library")] })]
          : []),
      ],
      owned: (s) => pressedAt(s, /add to library/i) !== undefined,
    });
    expect(await walkCheckout(probe, { ...CHECKOUT_TIMING, outcomeMs: 1_000 })).toEqual({
      claimed: true,
    });
    expect(pressedAt(seen, /add to library/i)).toBeDefined();
  });

  it("stops at once on a region lock, and says so", async () => {
    const { probe, seen } = scripted({
      views: freeCheckout({ window: { unavailable: true, buttons: [] } }),
    });
    const res = await walkCheckout(probe);
    expect(res.reason).toContain("Epic says the product is unavailable in your region");
    expect(seen.t).toBeLessThan(CHECKOUT_TIMING.settleMs + CHECKOUT_TIMING.pollMs * 2);
  });

  it("a purchase button that cannot be clicked is the reason, with no wait after it", async () => {
    const { probe, seen } = scripted({
      views: () => [view("page")],
      clickError: "locator.click: Timeout 10000ms exceeded.",
    });
    expect(await walkCheckout(probe)).toEqual({
      claimed: false,
      reason: "the 'Get' button could not be clicked (locator.click: Timeout [number]ms exceeded.)",
    });
    expect(seen.reloads).toBe(0);
  });

  it("confirmation copy already in the window next to its confirm button is not the outcome", async () => {
    // A launcher hint that reads like Epic's post-order copy, there from the moment the window
    // opens. Taken for the outcome, it skipped the confirm click and reported a phantom order.
    const { probe, seen } = scripted({
      views: freeCheckout({ window: { confirmed: true } }),
      owned: (s) => pressedAt(s, /add to library/i) !== undefined,
    });
    const res = await walkCheckout(probe, { ...CHECKOUT_TIMING, outcomeMs: 2_000 });
    expect(res).toEqual({ claimed: true });
    expect(pressedAt(seen, /add to library/i)).toBeDefined();
    // Still there after the click, it is not taken for Epic's word either: the wait ran out and
    // the one reload decided.
    expect(seen.t - pressedAt(seen, /add to library/i)!).toBeGreaterThanOrEqual(2_000);
    expect(seen.reloads).toBe(1);
  });

  it("copy that appears before the click only after the window's empty shell is still not the outcome", async () => {
    // The first look can catch the window before it renders. Sampling the copy only then let a
    // launcher hint that rendered one look later pass for Epic's answer the moment the confirm
    // button was clicked, and the verification reload half a second later killed the order.
    const { probe, seen } = scripted({
      views: (s) => {
        if (s.clickedCta === undefined) return [view("page")];
        const shell = s.t - s.clickedCta < 1_000;
        return [
          view("page"),
          view("checkout", {
            buttons: shell ? [] : [button("Add to library")],
            confirmed: !shell,
          }),
        ];
      },
      owned: (s) => pressedAt(s, /add to library/i) !== undefined,
    });
    const res = await walkCheckout(probe, { ...CHECKOUT_TIMING, outcomeMs: 2_000 });
    expect(res).toEqual({ claimed: true });
    // Not taken for the answer: the wait ran its course and the one reload decided.
    expect(seen.t - pressedAt(seen, /add to library/i)!).toBeGreaterThanOrEqual(2_000);
    expect(seen.reloads).toBe(1);
  });

  it("copy that was in the window at open counts once it has gone and come back after the click", async () => {
    const { probe, seen } = scripted({
      views: (s) => {
        if (s.clickedCta === undefined) return [view("page")];
        const at = pressedAt(s, /add to library/i);
        // The window re-renders after the click (busy button, no copy), then shows the outcome.
        const phase = at === undefined ? "before" : s.t - at < 1_000 ? "busy" : "done";
        return [
          view("page"),
          view("checkout", {
            buttons: phase === "done" ? [] : [button("Add to library", { busy: phase === "busy" })],
            confirmed: phase !== "busy",
          }),
        ];
      },
      owned: () => true,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    const waited = seen.t - pressedAt(seen, /add to library/i)!;
    expect(waited).toBeGreaterThanOrEqual(1_000);
    expect(waited).toBeLessThan(CHECKOUT_TIMING.outcomeMs);
  });

  it("a window that opens straight onto the confirmation, with no confirm button, is a confirmation", async () => {
    const { probe, seen } = scripted({
      views: (s) => [
        view("page"),
        ...(s.clickedCta !== undefined ? [view("checkout", { confirmed: true })] : []),
      ],
      owned: () => true,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(seen.pressed).toEqual([]);
    expect(seen.t).toBeLessThan(CHECKOUT_TIMING.settleMs + CHECKOUT_TIMING.pollMs * 3);
  });

  it("confirmation copy on the page while the confirm button waits for its click is not the outcome", async () => {
    const { probe, seen } = scripted({
      views: (s) => {
        if (s.clickedCta === undefined) return [view("page")];
        const ordered = pressedAt(s, /add to library/i) !== undefined;
        return [
          view("page", { confirmed: true }),
          view("checkout", { buttons: ordered ? [] : [button("Add to library")] }),
        ];
      },
      owned: (s) => pressedAt(s, /add to library/i) !== undefined,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: true });
    expect(pressedAt(seen, /add to library/i)).toBeDefined();
  });

  it("a placeholder Get that turns to In Library after the click, with no window, is already owned", async () => {
    const { probe, seen } = scripted({
      views: (s) => [
        view("page", {
          cta: s.clickedCta !== undefined && s.t - s.clickedCta >= 1_000 ? "In Library" : "Get",
        }),
      ],
      owned: () => true,
    });
    expect(await walkCheckout(probe)).toEqual({ claimed: false, alreadyOwned: true });
    // Checked against a reload first, and nothing waited out the window's budget.
    expect(seen.reloads).toBe(1);
    expect(seen.t - seen.clickedCta!).toBeLessThan(CHECKOUT_TIMING.openMs);
  });

  it("an In Library the reloaded page does not back up is not taken for owned", async () => {
    const { probe, seen } = scripted({
      views: (s) => [view("page", { cta: s.clickedCta !== undefined ? "In Library" : "Get" })],
    });
    const res = await walkCheckout(probe);
    expect(res.claimed).toBe(false);
    expect(res.alreadyOwned).toBeUndefined();
    expect(res.reason).toContain(
      "clicked 'Get'; the purchase button turned to 'In Library' before any purchase window opened; " +
        "the product page did not show it as owned after 3 reloads",
    );
    expect(seen.reloads).toBe(CHECKOUT_TIMING.verifyTries);
  });

  it("a page that closes mid-checkout ends the walk at once, and says so", async () => {
    const { probe, seen } = scripted({
      views: freeCheckout(),
      closed: (s) => s.clickedCta !== undefined && s.t - s.clickedCta >= 1_000,
    });
    const res = await walkCheckout(probe);
    expect(res.claimed).toBe(false);
    expect(res.reason).toContain("the product page closed before the checkout ended");
    expect(seen.t - seen.clickedCta!).toBeLessThan(1_000 + CHECKOUT_TIMING.pollMs * 2);
  });
});

describe("isOwnedLabel", () => {
  it("reads the owned labels, and not an offer to add to the library", () => {
    expect(isOwnedLabel("In Library")).toBe(true);
    expect(isOwnedLabel("Dans la bibliothèque")).toBe(true);
    expect(isOwnedLabel("Get")).toBe(false);
    expect(isOwnedLabel("Add to library")).toBe(false);
    expect(isOwnedLabel("Ajouter à la bibliothèque")).toBe(false);
    expect(isOwnedLabel("Loading")).toBe(false);
    expect(isOwnedLabel(null)).toBe(false);
  });
});

describe("buttonName", () => {
  it("matches the whole label, never a longer button that starts with it", () => {
    expect(buttonName("Accept").test("Accept")).toBe(true);
    expect(buttonName("Accept").test("Accept All Cookies")).toBe(false);
    expect(buttonName("Continue").test("Continue browsing")).toBe(false);
    expect(buttonName("I Accept").test("Accept")).toBe(false);
  });

  it("is loose on case and whitespace, which rendering changes", () => {
    expect(buttonName("ADD TO LIBRARY").test("Add to library")).toBe(true);
    expect(buttonName("Add  to​ library").test("Add to library")).toBe(true);
  });

  it("takes the label as text, not as a pattern", () => {
    expect(buttonName("Yes, buy now (1)").test("Yes, buy now (1)")).toBe(true);
    expect(buttonName("a.b").test("axb")).toBe(false);
  });

  it("only anchors the start of a label the reader cut short", () => {
    const long = `Add to library ${"x".repeat(70)}`;
    expect(buttonName(long.slice(0, 80)).test(`${long} and more`)).toBe(true);
    expect(buttonName(long.slice(0, 80)).test(`Not ${long}`)).toBe(false);
  });
});

// --- The Playwright glue, against a store page that only has what the checkout touches ----------

const PRODUCT = "https://store.epicgames.com/en-US/p/x";
const PURCHASE = "https://www.epicgames.com/store/purchase?offers=1-ns-offer";
const game = { title: "Game X", url: PRODUCT };

// Real-clock budgets, kept tiny: the fake page never really waits.
const FAST: CheckoutTiming = {
  ctaSettleMs: 50,
  settleMs: 5,
  openMs: 50,
  confirmMs: 50,
  outcomeMs: 50,
  verifyTries: 2,
  verifyGapMs: 5,
  pollMs: 5,
};

const NOTHING = {
  buttons: [] as CheckoutButton[],
  captcha: false,
  confirmed: false,
  unavailable: false,
  eula: false,
  pin: false,
  cta: null as string | null,
};

/**
 * How getByRole matches a name, as far as these fakes need it: a pattern is tested against the
 * accessible name, a string is a case-insensitive substring of it unless `exact` is set.
 */
function roleNameMatches(accessible: string, name: string | RegExp, exact?: boolean): boolean {
  const norm = accessible.replace(/\s+/g, " ").trim();
  if (name instanceof RegExp) return name.test(norm);
  const want = name.replace(/\s+/g, " ").trim();
  return exact ? norm === want : norm.toLowerCase().includes(want.toLowerCase());
}

/**
 * A product page whose purchase button opens a purchase window, both scripted against the time
 * the driver has asked to wait. Clicking "Add to library" places the order; Epic confirms it
 * `confirmsAfter` ms later (never, if left out), and a reload from then on shows it owned.
 */
function storePage(s: {
  /** How long after the click the purchase window appears; never, for Infinity. */
  opensAfter?: number;
  buttons?: string[];
  /** Where a captcha challenge shows: the purchase window itself, or a frame inside it. */
  captchaIn?: "window" | "nested";
  confirmsAfter?: number;
  /**
   * A cookie banner's "Accept All Cookies" on the page from the start, and after the click a EULA
   * dialog behind it, whose agree box and "Accept" stand before the purchase window.
   */
  eula?: boolean;
  /** The page closes once the purchase button was clicked. */
  closesAfterGet?: boolean;
  /** The page's clock fails (a crashed page): every waitForTimeout rejects at once. */
  clockFails?: boolean;
}) {
  let waited = 0;
  let getAt: number | undefined;
  let acceptedAt: number | undefined;
  let orderAt: number | undefined;
  let sinceOrderAtReload: number | undefined;
  let owned = false;
  let agreed = false;
  let inFlight = 0;
  let mostInFlight = 0;
  const gotoTimeouts: (number | undefined)[] = [];
  const clicks: string[] = [];
  const read: string[] = [];
  const confirmed = () =>
    orderAt !== undefined && waited - orderAt >= (s.confirmsAfter ?? Infinity);
  // With a EULA in the way, the window opens once it was accepted.
  const openedFrom = () => (s.eula ? acceptedAt : getAt);
  const open = () => {
    const from = openedFrom();
    return from !== undefined && waited - from >= (s.opensAfter ?? 0);
  };
  const closed = () => s.closesAfterGet === true && getAt !== undefined;
  const label = () => (owned ? "In Library" : "Get");
  const eulaShowing = () => s.eula === true && getAt !== undefined && acceptedAt === undefined;
  const shown = (text: string, inDialog = false): CheckoutButton => ({
    label: text,
    enabled: true,
    busy: false,
    inDialog,
  });

  type Contents = typeof NOTHING;
  const frame = (
    name: string,
    url: string,
    parent: unknown,
    contents: () => Contents,
    onClick: (label: string) => void = () => undefined,
  ) => ({
    url: () => url,
    parentFrame: () => parent,
    evaluate: async () => {
      // Held over a turn of the event loop, so reads that overlap can be told from reads in turn.
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      read.push(name);
      return contents();
    },
    getByRole: (_role: string, opts: { name: string | RegExp; exact?: boolean }) => {
      const target = {
        first: () => target,
        // The first button whose name matches, in page order, as Playwright would pick it.
        click: async () => {
          const hit = contents().buttons.find((b) => roleNameMatches(b.label, opts.name, opts.exact));
          if (!hit) throw new Error("locator.click: Timeout 5000ms exceeded.");
          clicks.push(hit.label);
          onClick(hit.label);
        },
      };
      return target;
    },
    locator: () => {
      const box = {
        first: () => box,
        check: async () => {
          if (name === "page") agreed = true;
        },
      };
      return box;
    },
  });
  let cookiesAccepted = false;
  const main = frame(
    "page",
    PRODUCT,
    null,
    () => ({
      ...NOTHING,
      cta: label(),
      eula: eulaShowing() && !agreed,
      buttons: [
        // Epic's cookie banner is a dialog too, and it comes first in the page.
        ...(s.eula && !cookiesAccepted ? [shown("Accept All Cookies", true)] : []),
        ...(eulaShowing() ? [shown("Accept", true)] : []),
      ],
    }),
    (clicked) => {
      if (clicked === "Accept All Cookies") cookiesAccepted = true;
      if (clicked === "Accept" && agreed) acceptedAt = waited;
    },
  );
  const purchase = frame(
    "window",
    PURCHASE,
    main,
    () => ({
      ...NOTHING,
      buttons: (s.buttons ?? ["Add to library"]).map((l) => shown(l)),
      captcha: s.captchaIn === "window",
      confirmed: confirmed(),
    }),
    (clicked) => {
      if (/add to library/i.test(clicked)) orderAt = waited;
    },
  );
  // A frame inside the purchase window holding the challenge, and hCaptcha's own frame inside
  // that, which is never read: the frame holding it says whether it shows.
  const nested = frame("nested", "about:blank", purchase, () => ({
    ...NOTHING,
    captcha: s.captchaIn === "nested",
  }));
  const hcaptcha = frame(
    "hcaptcha",
    "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge",
    nested,
    () => ({ ...NOTHING, captcha: true }),
  );

  const cta = {
    first: () => cta,
    count: async () => 1,
    textContent: async () => label(),
    click: async () => {
      clicks.push("Get");
      getAt = waited;
    },
  };
  const page = {
    goto: async (_url: string, opts?: { timeout?: number }) => {
      gotoTimeouts.push(opts?.timeout);
      if (orderAt !== undefined) sinceOrderAtReload = waited - orderAt;
      if (confirmed()) owned = true;
      // A reload is a fresh document: the purchase window is gone with the old one.
      getAt = undefined;
      acceptedAt = undefined;
      orderAt = undefined;
      return null;
    },
    waitForSelector: async () => undefined,
    waitForTimeout: async (ms: number) => {
      if (s.clockFails || closed()) throw new Error("Target page, context or browser has been closed");
      waited += ms;
    },
    isClosed: () => closed(),
    locator: () => cta,
    mainFrame: () => main,
    frames: () => (closed() ? [] : open() ? [main, purchase, nested, hcaptcha] : [main]),
  };
  return {
    session: { context: { pages: () => [page] } } as unknown as SessionHandle,
    clicks,
    read,
    gotos: () => gotoTimeouts.length,
    gotoTimeouts,
    mostInFlight: () => mostInFlight,
    sinceOrderAtReload: () => sinceOrderAtReload,
  };
}

const driver = (page: ReturnType<typeof storePage>, timing: CheckoutTiming = FAST) =>
  new PlaywrightEpicDriver(page.session, SIGN_IN_TIMING, timing);

describe("PlaywrightEpicDriver.claimGame checkout", () => {
  it("a captcha only inside the purchase window is seen, and handed to the captcha path", async () => {
    const page = storePage({ captchaIn: "window" });
    const res = await driver(page).claimGame(game);
    expect(res).toMatchObject({ claimed: false, captcha: true });
    expect(res.reason).toContain("in the purchase window");
    // Read on the checkout itself: nothing reloaded the product page before looking.
    expect(page.gotos()).toBe(1);
  });

  it("a captcha in a frame nested inside the purchase window counts too", async () => {
    const page = storePage({ captchaIn: "nested" });
    expect(await driver(page).claimGame(game)).toMatchObject({ claimed: false, captcha: true });
    expect(page.read).toContain("nested");
    expect(page.read).not.toContain("hcaptcha");
  });

  it("a purchase window that never opens says so", async () => {
    const page = storePage({ opensAfter: Infinity });
    expect(await driver(page).claimGame(game)).toEqual({
      claimed: false,
      reason:
        "clicked 'Get'; the purchase window did not open within 50 ms; the purchase button still reads 'Get'",
    });
  });

  it("a purchase window without a confirm button lists the buttons it had instead", async () => {
    const page = storePage({ buttons: ["Close", "Back"] });
    expect(await driver(page).claimGame(game)).toEqual({
      claimed: false,
      reason:
        "clicked 'Get'; purchase window opened; no 'Add to library' or 'Place Order' button " +
        "(buttons seen: Close, Back); the purchase button still reads 'Get'",
    });
    expect(page.clicks).toEqual(["Get"]);
  });

  it("a slow confirmation inside the window is a claim", async () => {
    const page = storePage({ confirmsAfter: 40 });
    const res = await driver(page, { ...FAST, outcomeMs: 5_000 }).claimGame(game);
    expect(res).toEqual({ claimed: true });
    expect(page.clicks).toEqual(["Get", "Add to library"]);
    // Waited for Epic, then reloaded once to see the game in the library.
    expect(page.sinceOrderAtReload()).toBeGreaterThanOrEqual(40);
    expect(page.gotos()).toBe(2);
  });

  it("a confirmation that never arrives is the reason, with every step before it", async () => {
    const page = storePage({});
    expect(await driver(page).claimGame(game)).toEqual({
      claimed: false,
      reason:
        "clicked 'Get'; purchase window opened; clicked 'Add to library'; no confirmation within 50 ms; " +
        "the purchase button still reads 'Get'",
    });
  });

  it("clicks the EULA's Accept, never the cookie banner's Accept All Cookies before it", async () => {
    // getByRole takes a string name as a substring, so asking for "Accept" clicked whichever
    // button containing it came first: here, the cookie banner.
    const page = storePage({ eula: true, confirmsAfter: 0 });
    expect(await driver(page).claimGame(game)).toEqual({ claimed: true });
    expect(page.clicks).toEqual(["Get", "Accept", "Add to library"]);
  });

  it("reads every frame of a look at once, not one after the other", async () => {
    const page = storePage({ captchaIn: "nested" });
    await driver(page).claimGame(game);
    // The page, the purchase window and the frame inside it, all in flight together.
    expect(page.mostInFlight()).toBe(3);
  });

  it("bounds each verification reload, and leaves the first load of the page as it was", async () => {
    const page = storePage({ confirmsAfter: 0 });
    expect(await driver(page).claimGame(game)).toEqual({ claimed: true });
    expect(page.gotoTimeouts).toEqual([undefined, 15_000]);
  });

  it("a page that closes during the checkout ends it with that reason", async () => {
    const page = storePage({ closesAfterGet: true });
    const res = await driver(page, { ...FAST, openMs: 60_000 }).claimGame(game);
    expect(res.claimed).toBe(false);
    expect(res.reason).toContain("clicked 'Get'; the product page closed before the checkout ended");
  });

  it("waits on a timer when the page's own clock fails, instead of spinning to the deadline", async () => {
    const page = storePage({ opensAfter: Infinity, clockFails: true });
    const res = await driver(page, { ...FAST, openMs: 100, pollMs: 10 }).claimGame(game);
    expect(res.reason).toContain("the purchase window did not open within 100 ms");
    // About one look per poll over the 100 ms, where a spin makes it hundreds.
    expect(page.read.length).toBeLessThan(30);
  });
});
