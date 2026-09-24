import { describe, expect, it } from "vitest";
import { PlaywrightEpicDriver, SIGN_IN_TIMING } from "../src/epic/driver.js";
import {
  CHECKOUT_TIMING,
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
}) {
  let waited = 0;
  let gotos = 0;
  let getAt: number | undefined;
  let orderAt: number | undefined;
  let sinceOrderAtReload: number | undefined;
  let owned = false;
  const clicks: string[] = [];
  const read: string[] = [];
  const confirmed = () =>
    orderAt !== undefined && waited - orderAt >= (s.confirmsAfter ?? Infinity);
  const open = () => getAt !== undefined && waited - getAt >= (s.opensAfter ?? 0);
  const label = () => (owned ? "In Library" : "Get");

  const frame = (name: string, url: string, parent: unknown, contents: () => unknown) => ({
    url: () => url,
    parentFrame: () => parent,
    evaluate: async () => {
      read.push(name);
      return contents();
    },
    getByRole: (_role: string, opts: { name: string }) => {
      const target = {
        first: () => target,
        click: async () => {
          clicks.push(opts.name);
          if (/add to library/i.test(opts.name)) orderAt = waited;
        },
      };
      return target;
    },
    locator: () => {
      const box = { first: () => box, check: async () => undefined };
      return box;
    },
  });
  const main = frame("page", PRODUCT, null, () => ({ ...NOTHING, cta: label() }));
  const purchase = frame("window", PURCHASE, main, () => ({
    ...NOTHING,
    buttons: (s.buttons ?? ["Add to library"]).map((l) => ({
      label: l,
      enabled: true,
      busy: false,
      inDialog: false,
    })),
    captcha: s.captchaIn === "window",
    confirmed: confirmed(),
  }));
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
    goto: async () => {
      gotos += 1;
      if (orderAt !== undefined) sinceOrderAtReload = waited - orderAt;
      if (confirmed()) owned = true;
      // A reload is a fresh document: the purchase window is gone with the old one.
      getAt = undefined;
      orderAt = undefined;
      return null;
    },
    waitForSelector: async () => undefined,
    waitForTimeout: async (ms: number) => {
      waited += ms;
    },
    locator: () => cta,
    mainFrame: () => main,
    frames: () => (open() ? [main, purchase, nested, hcaptcha] : [main]),
  };
  return {
    session: { context: { pages: () => [page] } } as unknown as SessionHandle,
    clicks,
    read,
    gotos: () => gotos,
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
});
