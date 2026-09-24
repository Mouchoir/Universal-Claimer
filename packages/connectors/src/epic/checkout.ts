// Epic's checkout, from the click on the purchase button to the verdict. The walk itself
// (walkCheckout) only talks to a CheckoutProbe, so its waits and verdicts are unit-tested without
// a browser; the frame reading it relies on is at the bottom of this file, and the driver in
// driver.ts supplies the rest.
import type { Frame } from "playwright-core";

/** How one claim ended. */
export interface EpicClaimAttempt {
  claimed: boolean;
  captcha?: boolean;
  alreadyOwned?: boolean;
  /** Where the checkout stopped, step by step, when it did not end in the library. */
  reason?: string;
}

/** How long each step of the checkout gets. */
export interface CheckoutTiming {
  /** How long the purchase button's label gets to leave its empty or "Loading" state. */
  ctaSettleMs: number;
  /** The pause before the label is read again and clicked. */
  settleMs: number;
  /** How long the purchase window gets to open after the click. */
  openMs: number;
  /** How long its confirm button gets to become clickable once it has opened. */
  confirmMs: number;
  /** How long the order gets to confirm once the confirm button was clicked. */
  outcomeMs: number;
  /** How many times the product page is reloaded to find a confirmed order in the library... */
  verifyTries: number;
  /** ...and the pause between two of those reloads. */
  verifyGapMs: number;
  /** How often the page is looked at again while waiting. */
  pollMs: number;
}

/**
 * The budgets are the references' own order of magnitude: vogler/free-games-claimer waits up to
 * 60 s at each step, P-Adamiec/Free-Games-Claimer-Remaster re-reads ownership three times over
 * about 30 s because the library lags the order. The fixed 5 s this replaces read a slow
 * confirmation as a failure.
 *
 * They are not the whole of it, and a run's length should be planned on the sum. With every wait
 * running out, one game's walk takes about four minutes: the two settle pauses and the click on
 * the purchase button (up to 14 s, more when notices have to be cleared first), the three step
 * budgets back to back (90 s, each overrun by at most one look of up to 3 s and the clicks it
 * leads to, up to 5 s each), then up to three verification reloads of up to 37 s each (15 s to
 * load, 12 s for the purchase button to appear, 10 s for it to settle) with 5 s between them. The
 * driver's first read of the product page, before the walk, can add up to another 52 s.
 */
export const CHECKOUT_TIMING: CheckoutTiming = {
  ctaSettleMs: 10_000,
  settleMs: 2_000,
  openMs: 30_000,
  confirmMs: 30_000,
  outcomeMs: 30_000,
  verifyTries: 3,
  verifyGapMs: 5_000,
  pollMs: 500,
};

/**
 * Where a frame sits: the product page itself, the purchase window (or a frame inside it), or
 * another Epic-hosted frame that turns into a checkout if a confirm button shows up in it.
 */
export type CheckoutFrameKind = "page" | "checkout" | "frame";

export interface CheckoutButton {
  label: string;
  enabled: boolean;
  /** Epic's own loading state is on it: a click now is silently lost. */
  busy: boolean;
  /** It sits in a dialog, not in the page behind it. */
  inDialog: boolean;
}

/** What one frame shows, as far as the checkout is concerned. Facts only, no decisions. */
export interface CheckoutView {
  /** Which frame this was read from, for clicking back into it. */
  id: string;
  kind: CheckoutFrameKind;
  /** The visible buttons, in page order. */
  buttons: CheckoutButton[];
  /** A captcha challenge is showing - not merely loaded, which the invisible hCaptcha always is. */
  captcha: boolean;
  /** Visible error text in the frame, as the page wrote it. */
  error?: string;
  /** Epic's own "it is yours" copy is on the frame. */
  confirmed: boolean;
  /** "unavailable in your region". */
  unavailable: boolean;
  /** The EULA's agree box is there and not ticked. */
  eula: boolean;
  /** The parental-controls PIN is asked for. */
  pin: boolean;
  /** The product page's purchase button label; null where there is none. */
  cta: string | null;
}

/**
 * What the checkout walk reads from and does to the browser, kept behind an interface for the same
 * reason as the sign-in check's probe in driver.ts: the waiting and the verdict are the part worth
 * testing.
 */
export interface CheckoutProbe {
  /** Every frame worth reading, the product page first. */
  look(): Promise<CheckoutView[]>;
  /** Click the product page's purchase button: undefined when it went through, else why not. */
  clickCta(): Promise<string | undefined>;
  /** Click the button with this label in the frame the view was read from. */
  press(view: CheckoutView, label: string): Promise<boolean>;
  /** Tick the EULA's agree box in that frame. */
  agree(view: CheckoutView): Promise<boolean>;
  /** Reload the product page and read whether the account owns the product now. */
  owned(): Promise<boolean>;
  /** The purchase button's label on the page as it is now. */
  ctaLabel(): Promise<string | undefined>;
  /** The product page has closed: nothing on it is left to wait for. */
  closed(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The reason a claim gives when the product page has no purchase button at all. */
export const NO_CTA = "no purchase button on the page";

/**
 * The purchase window's confirm button. "Add to library" since Epic's free checkout changed on
 * 2026-05-28 (vogler/free-games-claimer dev, epic-games.js, commit 28b0afc7); "Place Order" before
 * that, and still on paid-style checkouts. The English labels are what the en-US pin renders; the
 * French ones are a fallback that costs nothing if Epic ever ignores the pin.
 */
const CONFIRM_LABEL = /add to library|place order|ajouter .*biblioth|passer la commande|^obtenir$/i;

/**
 * An agreement standing between the order and the library: the EULA's "Accept" (vogler dev
 * epic-games.js, after `input#agree`) and the EU right-of-withdrawal notice's "I Accept", which a
 * French account gets after the confirm click (vogler dev epic-games.js in the purchase frame;
 * P-Adamiec/Free-Games-Claimer-Remaster src/stores/epic.py also found it on the page itself).
 * Anchored, so a cookie banner's "Accept All Cookies" is never taken for one.
 */
const ACCEPT_LABEL = /^(i accept|i agree|accept|j['’]accepte|accepter)$/i;

/**
 * A store notice that only lets you go on: mature content before the click, "Device not
 * supported" after it, an updated privacy policy. vogler dev epic-games.js clicks
 * `button:has-text("Continue")` for all three.
 */
const CONTINUE_LABEL = /^(continue|continuer)$/i;

/**
 * "This edition contains something you already have. Still interested?" (vogler dev
 * epic-games.js).
 */
const BUY_ANYWAY_LABEL = /^yes,? buy now$/i;

/** A notice whose button does not go away after this many clicks will not after more. */
const MAX_PRESSES = 2;

/**
 * Handed to {@link readCheckoutView}, which runs in the page and so cannot reach module scope.
 * Class and id selectors come first because they do not change with the language.
 */
const READER = {
  // Epic's own box around the checkout's hCaptcha (vogler dev epic-games.js,
  // `#h_captcha_challenge_checkout_free_prod iframe`), the one around the login page's
  // (`.h_captcha_challenge iframe`, same file), and any hCaptcha or reCAPTCHA challenge frame.
  captcha: [
    "#h_captcha_challenge_checkout_free_prod iframe",
    "[id^='h_captcha_challenge'] iframe",
    ".h_captcha_challenge iframe",
    "iframe[src*='hcaptcha'][src*='frame=challenge']",
    "iframe[src*='recaptcha'][src*='bframe']",
  ].join(", "),
  // `.payment__errors` is where Epic's checkout writes its errors (vogler dev epic-games.js);
  // `.payment-alert--ERROR` is the older alert (claabs/epicgames-freegames-node v4.1.0,
  // src/puppet/purchase.ts).
  errors: ".payment__errors, .payment-alert--ERROR",
  // A confirm button still carrying this ignores clicks (vogler dev epic-games.js,
  // `:not(:has(.payment-loading--loading))`, their issue #84).
  busy: ".payment-loading--loading",
  pin: ".payment-pin-code",
  // Where a button's label is cut: enough for any label worth clicking, short enough for a summary.
  labelMax: 80,
  // The post-order copy, which Epic changed three times in 2026: "It's all yours" (vogler dev
  // 28b0afc7), "Download the Epic Games Launcher to play" (50fef25e), "Is Epic Games Launcher
  // installed?" (ccb9e726). "Thanks for your order!" is the one before them all.
  confirmed:
    "it['’]s all yours|thanks for your order|download the epic games launcher to play|is epic games launcher installed\\?",
  unavailable: "unavailable in your region",
};

type RawCheckoutView = Omit<CheckoutView, "id" | "kind">;

/**
 * Runs inside a frame, so it must stand on its own: Playwright ships the function's source, not
 * its closure. It reads facts and decides nothing; {@link walkCheckout} does the deciding, where
 * a test can reach it.
 */
function readCheckoutView(sel: typeof READER): RawCheckoutView {
  // Playwright's own notion of visible: a box, and not visibility:hidden. The hCaptcha challenge
  // frame is in the DOM from the start and only shown when a challenge is actually set.
  const shown = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const squash = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  // What shows, but in the page's own spelling: innerText carries CSS text-transform ("ADD TO
  // LIBRARY"), textContent also carries hidden text. The latter only wins when all that differs
  // is the case.
  const text = (el: Element): string => {
    const rendered = squash((el as HTMLElement).innerText);
    const source = squash(el.textContent);
    return rendered && rendered.toLowerCase() !== source.toLowerCase() ? rendered : source;
  };
  const buttons: CheckoutButton[] = [];
  for (const b of Array.from(document.querySelectorAll("button, [role='button']"))) {
    // Generous: a dialog is usually appended last, behind every button the product page has.
    if (buttons.length >= 150) break;
    if (!shown(b)) continue;
    const label = (b.getAttribute("aria-label") ?? "").trim() || text(b);
    if (!label) continue;
    buttons.push({
      label: label.slice(0, sel.labelMax),
      enabled: !(b as HTMLButtonElement).disabled && b.getAttribute("aria-disabled") !== "true",
      busy:
        b.matches(sel.busy) ||
        b.querySelector(sel.busy) !== null ||
        b.getAttribute("aria-busy") === "true",
      inDialog: b.closest("[role='dialog'], [role='alertdialog'], [aria-modal='true']") !== null,
    });
  }
  const error = Array.from(document.querySelectorAll(sel.errors))
    .filter(shown)
    .map(text)
    .find((t) => t.length > 0);
  // Rendered text only: a page's inline scripts can carry its translations, confirmation copy
  // included, and textContent would read those as if they were showing.
  const body = squash(document.body?.innerText);
  const agree = document.querySelector("input#agree") as HTMLInputElement | null;
  const cta = document.querySelector("[data-testid='purchase-cta-button']");
  return {
    buttons,
    captcha: Array.from(document.querySelectorAll(sel.captcha)).some(shown),
    ...(error ? { error: error.slice(0, 300) } : {}),
    confirmed: new RegExp(sel.confirmed, "i").test(body),
    unavailable: new RegExp(sel.unavailable, "i").test(body),
    // Not required to be visible: a styled checkbox is often the 1px input behind its label.
    eula: agree !== null && !agree.checked,
    // Shown, like the captcha: a checkout can carry the PIN form hidden for accounts that never
    // get asked, and a hidden one is no reason to stop.
    pin: Array.from(document.querySelectorAll(sel.pin)).some(shown),
    cta: cta ? text(cta) : null,
  };
}

/**
 * The purchase button's label for a product the account owns. A label that offers to add it
 * ("Ajouter à la bibliothèque") mentions the library too, so that is ruled out first, and
 * "Loading" is nobody's answer yet.
 */
export function isOwnedLabel(label: string | null | undefined): boolean {
  const l = (label ?? "").trim();
  if (!l || /^loading/i.test(l) || /\badd to\b|ajouter/i.test(l)) return false;
  return /in library|owned|installer|install|dans la biblioth|biblioth[eè]que/i.test(l);
}

/**
 * The accessible name to click a button by, from the label the walk decided on. Anchored at both
 * ends because getByRole takes a plain string name as a case-insensitive substring: the walk would
 * decide on the EULA's "Accept" and click the cookie banner's "Accept All Cookies" before it, or
 * a "Continue browsing" for a "Continue". Case-insensitive and loose on whitespace, since the label
 * was read from rendered text and the name is computed from the DOM, and only anchored at its
 * start when the reader may have cut the label short.
 */
export function buttonName(label: string): RegExp {
  // Playwright drops these two from an accessible name before comparing it.
  const name = label.replace(/[\u200b\u00ad]/g, "").replace(/\s+/g, " ").trim();
  const body = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`^${body}${label.length >= READER.labelMax ? "" : "$"}`, "i");
}

/**
 * Page text made fit for a run summary: short, and with nothing in it that looks like an address
 * or an account or card number. It ends up in the run history and in the outbound notification.
 */
function scrub(s: string, max = 80): string {
  const t = s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\S+@\S+\.\S+/g, "[email]")
    .replace(/\d{4,}/g, "[number]");
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function duration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** The labels a reader of the summary needs to see what the window offered instead. */
function buttonsSeen(buttons: CheckoutButton[]): string {
  const labels = [...new Set(buttons.map((b) => scrub(b.label, 40)))].slice(0, 6);
  return labels.length > 0 ? `buttons seen: ${labels.join(", ")}` : "no buttons seen";
}

function isConfirm(b: CheckoutButton): boolean {
  return CONFIRM_LABEL.test(b.label);
}

/**
 * The frames that are the checkout: the purchase window, and any other Epic frame a confirm button
 * shows up in. Since September 2026 Epic sometimes opens its checkout in a frame outside the usual
 * container (feldorn/free-games-claimer issue #151), so the URL alone is not enough.
 */
function checkoutViews(views: CheckoutView[]): CheckoutView[] {
  return views.filter(
    (v) => v.kind === "checkout" || (v.kind === "frame" && v.buttons.some(isConfirm)),
  );
}

/** Confirm buttons, in a checkout frame or in a dialog on the page - not the page's own CTA. */
function confirmButtons(views: CheckoutView[]): { view: CheckoutView; button: CheckoutButton }[] {
  return views.flatMap((view) =>
    view.buttons
      .filter((b) => isConfirm(b) && (view.kind !== "page" || b.inDialog))
      .map((button) => ({ view, button })),
  );
}

/**
 * Click through whatever stands between the click and the order: a notice on the page, the EULA,
 * the right-of-withdrawal notice. Each is recorded, so a summary says what was in the way.
 */
async function clearInterstitials(
  probe: CheckoutProbe,
  views: CheckoutView[],
  trail: string[],
  presses: Map<string, number>,
): Promise<boolean> {
  const checkout = new Set(checkoutViews(views));
  let pressed = false;
  const take = (key: string): number | undefined => {
    const n = presses.get(key) ?? 0;
    if (n >= MAX_PRESSES) return undefined;
    presses.set(key, n + 1);
    return n;
  };
  for (const v of views) {
    const inCheckout = checkout.has(v);
    // vogler dev epic-games.js: `input#agree` checked, then Accept. On the page or in the window.
    const eulaKey = `eula ${v.kind}`;
    if (v.eula && (inCheckout || v.kind === "page")) {
      const n = take(eulaKey);
      if (n !== undefined && (await probe.agree(v))) {
        if (n === 0) trail.push("ticked the EULA's agree box");
        pressed = true;
      }
    }
    // On the page an Accept is only taken inside a dialog, or once the EULA's box was ticked
    // there: vogler clicks the EULA's Accept wherever it is, and it need not be marked a dialog.
    const agreedHere = presses.has(eulaKey);
    for (const b of v.buttons) {
      if (!b.enabled || b.busy) continue;
      const wanted = ACCEPT_LABEL.test(b.label)
        ? inCheckout || (v.kind === "page" && (b.inDialog || agreedHere))
        : (CONTINUE_LABEL.test(b.label) || BUY_ANYWAY_LABEL.test(b.label)) && v.kind === "page";
      if (!wanted) continue;
      const n = take(b.label.toLowerCase());
      if (n === undefined) continue;
      if (await probe.press(v, b.label)) {
        if (n === 0) trail.push(`clicked '${scrub(b.label, 40)}'`);
        pressed = true;
      }
    }
  }
  return pressed;
}

/**
 * Click through Epic's checkout for a product the page offers, and decide how it ended.
 *
 * Every step it reaches goes on a trail that becomes the reason when the claim does not end in
 * the library: whether the purchase window opened, which confirm button it clicked or which
 * buttons it saw instead, what notices it cleared, what error the window showed. It is all read
 * before anything navigates away; the old flow reloaded the product page first and then looked
 * for a captcha on the fresh page, so all a failure could ever say was the button's label.
 *
 * A captcha anywhere - the product page, the purchase window, or a frame inside it - ends the
 * walk with `captcha: true`, which the caller hands to a person.
 *
 * It waits for an outcome instead of a fixed time: Epic's confirmation in the window once the
 * confirm button was clicked, or the purchase button turning to its owned state, each within its
 * budget. Either is then checked against a reload of the product page, a few times since the
 * library lags the order: the checkout only says what it thinks happened, the library says what
 * is true (the lesson P-Adamiec/Free-Games-Claimer-Remaster v1.8 "Verify Epic claims" drew from
 * phantom claims).
 * Without either signal, one reload still decides - Epic has changed its confirmation copy often
 * enough that a claim may land with nothing here recognising it.
 */
export async function walkCheckout(
  probe: CheckoutProbe,
  timing: CheckoutTiming = CHECKOUT_TIMING,
): Promise<EpicClaimAttempt> {
  const trail: string[] = [];
  const presses = new Map<string, number>();
  const reason = (...last: (string | undefined)[]) =>
    [...trail, ...last].filter((s): s is string => Boolean(s)).join("; ");
  const stillReads = async (): Promise<string | undefined> => {
    const label = await probe.ctaLabel().catch(() => undefined);
    if (!label) return undefined;
    return label === NO_CTA ? label : `the purchase button still reads '${scrub(label, 40)}'`;
  };

  // Epic shows a placeholder "Get" while the account's ownership loads and turns it into
  // "In Library" a second or two later; clicking the placeholder claims nothing and reads as a
  // failure. feldorn/free-games-claimer epic-games.js re-reads the button just before clicking.
  await probe.sleep(timing.settleMs);
  let views = await probe.look();
  const before = views.find((v) => v.kind === "page");
  if (isOwnedLabel(before?.cta)) return { claimed: false, alreadyOwned: true };
  const captchaFirst = views.find((v) => v.captcha);
  if (captchaFirst) {
    return {
      claimed: false,
      captcha: true,
      reason: "a captcha challenge is showing on the product page",
    };
  }
  // A mature-content notice sits in front of the button; vogler dev epic-games.js clicks its
  // Continue and gives the page 2 s before it clicks the purchase button.
  if (await clearInterstitials(probe, views, trail, presses)) await probe.sleep(timing.settleMs);
  // Epic's confirmation copy only counts on the page if it was not there before the click.
  const confirmedBefore = before?.confirmed === true;
  const label = scrub(before?.cta || "Get", 40);

  // A delay, because a click without one got stuck (vogler/free-games-claimer issue #75).
  const clickError = await probe.clickCta();
  if (clickError) {
    return {
      claimed: false,
      reason: reason(`the '${label}' button could not be clicked (${scrub(clickError, 120)})`),
    };
  }
  trail.push(`clicked '${label}'`);

  type Phase = "opening" | "confirming" | "waiting";
  let phase: Phase = "opening";
  let deadline = probe.now() + timing.openMs;
  let opened = false;
  let positive = false;
  let ownedAll = false;
  let stop: string | undefined;
  let seenConfirm: CheckoutButton | undefined;
  let confirmRefused = false;
  // Confirmation copy already in the window when it opened, next to a confirm button, is part of
  // the window (a launcher hint, say) and not the order's outcome: it only counts once it has
  // gone and come back.
  let copyAtOpen = false;
  const errors = new Set<string>();

  for (;;) {
    // A closed page answers every look with nothing and every pause at once; waiting on it would
    // only run the budgets down.
    if (probe.closed()) {
      stop = "the product page closed before the checkout ended";
      break;
    }
    views = await probe.look();
    const page = views.find((v) => v.kind === "page");
    const checkout = checkoutViews(views);
    const confirms = confirmButtons(views);

    if (!opened && (checkout.length > 0 || confirms.length > 0)) {
      opened = true;
      copyAtOpen = checkout.some((v) => v.confirmed) && confirms.length > 0;
      trail.push(
        checkout.length > 0 ? "purchase window opened" : "checkout opened in a dialog on the page",
      );
    }
    if (phase === "opening" && opened) {
      phase = "confirming";
      deadline = probe.now() + timing.confirmMs;
    }

    const challenged = views.find((v) => v.captcha);
    if (challenged) {
      const where = challenged.kind === "page" ? "on the product page" : "in the purchase window";
      return {
        claimed: false,
        captcha: true,
        reason: reason(`a captcha challenge is showing ${where}`),
      };
    }
    for (const v of checkout) {
      if (!v.error) continue;
      const said = `Epic said "${scrub(v.error)}"`;
      // Epic's hCaptcha gave up ("Failed to challenge captcha, please try again later.", which
      // vogler dev epic-games.js watches `.payment__errors` for): a person has to finish this one.
      if (/captcha/i.test(v.error)) return { claimed: false, captcha: true, reason: reason(said) };
      // Recorded, not a verdict: the window can recover by itself, and the wait stays bounded.
      if (!errors.has(said)) {
        errors.add(said);
        trail.push(said);
      }
    }
    // Neither of these clears by waiting (both from vogler dev epic-games.js).
    if (checkout.some((v) => v.unavailable)) {
      stop = "Epic says the product is unavailable in your region";
      break;
    }
    if (checkout.some((v) => v.pin)) {
      stop = "Epic asks for the parental-controls PIN, which is not entered automatically";
      break;
    }

    const windowCopy = checkout.some((v) => v.confirmed);
    if (copyAtOpen && checkout.length > 0 && !windowCopy) copyAtOpen = false;
    // The copy is what Epic says once an order went through, so it only counts once the confirm
    // button was clicked or none is showing any more; before that, next to a confirm button still
    // waiting for its click, it can only be something else the window or the page says.
    const settled = phase === "waiting" || confirms.length === 0;
    const pageCopy = page?.confirmed === true && !confirmedBefore;
    if (settled && ((windowCopy && !copyAtOpen) || pageCopy)) {
      trail.push("Epic confirmed the order");
      positive = true;
      break;
    }
    // The button turning to "In Library" in place is the one signal no copy change can break
    // (feldorn/free-games-claimer epic-games.js races it against the confirmation text).
    if (page && isOwnedLabel(page.cta)) {
      // With no window open yet, nothing was ordered: the "Get" clicked was Epic's placeholder
      // while it loaded ownership, only slower than the settle pause gave it.
      if (!opened) {
        ownedAll = true;
        break;
      }
      trail.push(`the purchase button turned to '${scrub(page.cta ?? "", 40)}'`);
      positive = true;
      break;
    }

    // After a notice is cleared the views are stale: the confirm button read with it may be the
    // one the notice was blocking, so it waits for the next look.
    const cleared = await clearInterstitials(probe, views, trail, presses);

    if (phase === "confirming" && !cleared) {
      seenConfirm = confirms[0]?.button ?? seenConfirm;
      const ready = confirms.find((c) => c.button.enabled && !c.button.busy);
      if (ready) {
        if (await probe.press(ready.view, ready.button.label)) {
          trail.push(`clicked '${scrub(ready.button.label, 40)}'`);
          phase = "waiting";
          deadline = probe.now() + timing.outcomeMs;
        } else {
          // Clickable by every sign, and the click still did not go through: something covers it.
          seenConfirm = ready.button;
          confirmRefused = true;
        }
      }
    }

    const left = deadline - probe.now();
    if (left <= 0) {
      if (phase === "opening") {
        const dialogs = (page?.buttons ?? []).filter((b) => b.inDialog);
        stop = `the purchase window did not open within ${duration(timing.openMs)}${
          dialogs.length > 0 ? ` (on the page, ${buttonsSeen(dialogs)})` : ""
        }`;
      } else if (phase === "confirming") {
        const state = confirmRefused ? "unclickable" : seenConfirm?.busy ? "busy" : "disabled";
        const offered = buttonsSeen(checkout.flatMap((v) => v.buttons));
        if (seenConfirm) {
          stop = `'${scrub(seenConfirm.label, 40)}' stayed ${state} for ${duration(timing.confirmMs)}`;
        } else if (checkout.length > 0) {
          stop = `no 'Add to library' or 'Place Order' button (${offered})`;
        } else {
          stop = "the purchase window closed without a confirm button";
        }
      } else {
        stop = `no confirmation within ${duration(timing.outcomeMs)}`;
      }
      break;
    }
    await probe.sleep(Math.min(timing.pollMs, left));
  }

  // The library has the last word, a few times over since it lags the order.
  const verified = async (): Promise<boolean> => {
    for (let i = 0; i < timing.verifyTries; i++) {
      if (i > 0) await probe.sleep(timing.verifyGapMs);
      if (await probe.owned()) return true;
    }
    return false;
  };
  const notShown = `the product page did not show it as owned after ${timing.verifyTries} reloads`;

  if (ownedAll) {
    if (await verified()) return { claimed: false, alreadyOwned: true };
    const turned = scrub(views.find((v) => v.kind === "page")?.cta ?? "", 40);
    return {
      claimed: false,
      reason: reason(
        `the purchase button turned to '${turned}' before any purchase window opened`,
        notShown,
        await stillReads(),
      ),
    };
  }
  if (positive) {
    if (await verified()) return { claimed: true };
    return { claimed: false, reason: reason(notShown, await stillReads()) };
  }
  if (await probe.owned()) return { claimed: true };
  return { claimed: false, reason: reason(stop, await stillReads()) };
}

/** A frame's host is Epic's own. */
function isEpicUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "epicgames.com" || host.endsWith(".epicgames.com");
  } catch {
    return false;
  }
}

/**
 * Epic's purchase window, by URL. `/purchase` is what it has always been served from;
 * P-Adamiec/Free-Games-Claimer-Remaster src/stores/epic.py also takes `payment`.
 */
function isPurchaseUrl(url: string): boolean {
  if (!isEpicUrl(url)) return false;
  try {
    return /\/(purchase|payment|checkout)\b/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Which frames are read, and as what. A frame inside the purchase window is part of it whatever
 * it is served from; that is where a challenge frame sits. Captcha providers' own frames are left
 * out: the frame that holds one is what says whether it is showing. Anything else not Epic's (a
 * trailer, an ad) is none of the checkout's business.
 */
export function frameKind(frame: Frame, main: Frame): CheckoutFrameKind | undefined {
  if (frame === main) return "page";
  const url = frame.url();
  if (/hcaptcha|recaptcha/i.test(url)) return undefined;
  for (let f: Frame | null = frame; f && f !== main; f = f.parentFrame()) {
    if (isPurchaseUrl(f.url())) return "checkout";
  }
  return isEpicUrl(url) ? "frame" : undefined;
}

/**
 * How long one frame gets to answer: a frame between documents may never have a context to run
 * in, and one frame must not hold up the whole look.
 */
const FRAME_READ_MS = 3_000;

export async function readFrame(frame: Frame): Promise<RawCheckoutView | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.evaluate(readCheckoutView, READER),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), FRAME_READ_MS);
      }),
    ]);
  } catch {
    // Detached, or navigating: it is read again on the next look.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
