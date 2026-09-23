"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One-click connection through the companion extension, replacing export-then-paste.
 *
 * The mechanism is the URL. Pressing the button mints a pairing token and puts it in this page's
 * query string; the extension popup reads the active tab's URL — which `activeTab` grants on
 * click, with no host permission at all — and so learns both where to send the session and what
 * authorises it. Nothing else in the design survives contact with both browsers:
 *
 *   - `externally_connectable` needs fixed origin patterns in the manifest, and a self-hosted
 *     instance's address is unknowable at build time. Firefox does not support it either.
 *   - A content script announcing itself needs a host permission for that same unknown origin,
 *     which in Firefox is optional and off until granted.
 *   - Probing `chrome-extension://<id>/…` works in Chrome, but Firefox gives every installation a
 *     random `moz-extension://` UUID that a page cannot construct.
 *
 * Reading the tab URL sidesteps all three, and behaves identically in both browsers.
 *
 * The consequence worth stating: this page cannot detect whether the extension is installed. So
 * it does not pretend to — it offers the install links alongside, rather than guessing and being
 * wrong in the one direction that leaves someone stuck.
 *
 * What the page waits on is the pairing's own outcome, reported by the instance. It used to wait
 * for "an account exists for this service", which is already true for every reconnect: the page
 * announced success two seconds in, navigated away, and took the pairing URL — the extension's
 * only way in — with it. So nothing was ever sent, and nothing said so.
 */

const STORES = {
  firefox: "https://addons.mozilla.org/firefox/addon/universal-claimer-exporter/",
  // Published from the same source; the id is fixed once the listing exists.
  chrome: "https://chromewebstore.google.com/detail/mlnemnpdpmafkadcgcipbncmbkmjpgjf",
};

const POLL_MS = 1500;
/** The bridge normally answers in a second or two. Past this, something is stuck. */
const BRIDGE_TIMEOUT_MS = 30_000;
/** Consecutive unreachable polls before the page says the instance cannot be reached. */
const UNREACHABLE_AFTER = 4;
const SIGNED_OUT = "You have been signed out. Sign in again, then press the button.";

/** Which store to lead with. Only ever used to order two links that are both always shown. */
function likelyBrowser(): "firefox" | "chrome" {
  if (typeof navigator === "undefined") return "chrome";
  return /firefox/i.test(navigator.userAgent) ? "firefox" : "chrome";
}

/** Take the pairing out of the address bar once it can no longer be used. */
function clearPairFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("pair")) return;
  url.searchParams.delete("pair");
  window.history.replaceState(null, "", url.toString());
}

interface PairingStatus {
  state: "pending" | "processing" | "connected" | "failed" | "expired" | "unknown";
  reconnected?: boolean;
  cookieCount?: number;
  hosts?: string[];
  error?: { code: string; message: string };
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  needsAccess?: boolean;
  service?: string;
  domains?: string[];
}

interface Props {
  serviceId: string;
  config: Record<string, string>;
  /** Called once the session has landed, so the page can move on. */
  onConnected: () => void;
  /** Test seam: how often the pairing status is polled, and how long success stays on screen. */
  pollMs?: number;
}

export function ExtensionSetup({ serviceId, config, onConnected, pollMs = POLL_MS }: Props) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<"firefox" | "chrome">("chrome");
  /** Set once the extension's bridge announces itself, which only happens on an allowed origin. */
  const [bridge, setBridge] = useState(false);
  /** What is happening right now. A silent button reads as a broken one. */
  const [phase, setPhase] = useState<string | null>(null);
  /** Shown when the extension is missing cookie access and the operator has to grant it. */
  const [needsAccess, setNeedsAccess] = useState<{ service: string; domains: string[] } | null>(
    null,
  );
  const [connected, setConnected] = useState<PairingStatus | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pairing being watched. Answers about any other one are stale and ignored. */
  const watchingRef = useRef<string | null>(null);
  const bridgeCleanupRef = useRef<(() => void) | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => setBrowser(likelyBrowser()), []);

  // Listen for the bridge, and ask for it: the content script announces on load, which may have
  // been before this component mounted.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type === "uc-extension-ready") setBridge(true);
      if (event.data?.type === "uc-extension-progress") setPhase(event.data.phase);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ type: "uc-extension-ready?" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const stopWatching = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    watchingRef.current = null;
    bridgeCleanupRef.current?.();
    bridgeCleanupRef.current = null;
  }, []);

  useEffect(() => stopWatching, [stopWatching]);

  /** End the attempt with a message, and put the button back so it can be pressed again. */
  const giveUp = useCallback(
    (message: string) => {
      stopWatching();
      clearPairFromUrl();
      setArmed(false);
      setBusy(false);
      setPhase(null);
      setNeedsAccess(null);
      setError(message);
    },
    [stopWatching],
  );

  const watch = useCallback(
    (pairingId: string) => {
      watchingRef.current = pairingId;
      let unreachable = 0;

      const next = () => {
        if (watchingRef.current === pairingId) pollRef.current = setTimeout(tick, pollMs);
      };

      async function tick(): Promise<void> {
        if (watchingRef.current !== pairingId) return;
        let res: Response | null = null;
        let body: PairingStatus | null = null;
        try {
          res = await fetch(`/api/connect/pair/${encodeURIComponent(pairingId)}`, {
            cache: "no-store",
          });
          body = (await res.json().catch(() => null)) as PairingStatus | null;
        } catch {
          res = null;
        }
        if (watchingRef.current !== pairingId) return;

        if (!res) {
          unreachable += 1;
          if (unreachable === UNREACHABLE_AFTER) {
            setError("This instance is not answering. It may be restarting — still waiting.");
          }
          return next();
        }
        if (unreachable >= UNREACHABLE_AFTER) setError(null);
        unreachable = 0;

        if (res.status === 401) return giveUp(SIGNED_OUT);
        if (res.status === 404 || body?.state === "unknown") {
          return giveUp(
            "This instance no longer knows about this pairing — it has probably restarted " +
              "since. Press the button again.",
          );
        }
        if (!res.ok || !body) return next();

        switch (body.state) {
          case "processing":
            setPhase("saving");
            return next();
          case "expired":
            return giveUp(
              "The pairing expired before the extension sent anything. Press the button again.",
            );
          case "failed":
            return giveUp(
              `The instance refused the session: ${body.error?.message ?? "no reason given"}`,
            );
          case "connected":
            stopWatching();
            clearPairFromUrl();
            setBusy(false);
            setPhase(null);
            setError(null);
            setNeedsAccess(null);
            setConnected(body);
            // Long enough to read what arrived; the dashboard is where it is confirmed.
            setTimeout(() => onConnectedRef.current(), pollMs);
            return;
          default:
            return next();
        }
      }

      void tick();
    },
    [giveUp, stopWatching, pollMs],
  );

  /** Ask the page bridge to read and send the session. Resolves with its answer or a timeout. */
  function askBridge(token: string): Promise<BridgeResult> {
    return new Promise((resolve) => {
      const onResult = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.type !== "uc-extension-result") return;
        done(event.data as BridgeResult);
      };
      const timer = setTimeout(
        () =>
          done({
            ok: false,
            error:
              "The extension did not answer. Click its icon in the toolbar and press " +
              '"Send to this instance" instead.',
          }),
        BRIDGE_TIMEOUT_MS,
      );
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onResult);
      };
      function done(result: BridgeResult) {
        cleanup();
        bridgeCleanupRef.current = null;
        resolve(result);
      }
      bridgeCleanupRef.current = cleanup;
      window.addEventListener("message", onResult);
      window.postMessage({ type: "uc-extension-connect", token, serviceId }, window.location.origin);
    });
  }

  async function arm() {
    stopWatching();
    setError(null);
    setNeedsAccess(null);
    setConnected(null);
    setPhase(null);
    setBusy(true);

    let token: string;
    let pairingId: string;
    try {
      const res = await fetch("/api/connect/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId, config }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.token || !data?.pairingId) {
        setBusy(false);
        setError(
          res.status === 401
            ? SIGNED_OUT
            : (data?.error?.message ?? `Could not start the pairing (${res.status}).`),
        );
        return;
      }
      token = data.token;
      pairingId = data.pairingId;
    } catch {
      setBusy(false);
      setError("Could not reach this instance.");
      return;
    }

    // The token goes in the URL on every path: it is the one thing the extension can read without
    // permission on this origin, and even the bridge re-derives it from the tab to refuse a page
    // asking for a pairing it was not issued. replaceState rather than a navigation — reloading
    // would throw away what the operator just filled in.
    const url = new URL(window.location.href);
    url.searchParams.set("pair", token);
    window.history.replaceState(null, "", url.toString());
    setArmed(true);

    // Watched whichever route the session takes. The bridge reports back directly, but the popup
    // route does not, and after a permission prompt the operator may well finish there.
    watch(pairingId);

    if (!bridge) {
      setBusy(false);
      return;
    }

    setPhase("starting");
    const result = await askBridge(token);
    if (watchingRef.current !== pairingId) return; // Settled, or started again, meanwhile.
    setBusy(false);

    if (result.ok) {
      // Sent. The instance's own record is what says it was stored, and the watch reads it.
      setPhase("saving");
      return;
    }
    setPhase(null);
    if (result.needsAccess) {
      // Not an error: the browser will not let a page ask for a permission, so this is the one
      // step that has to happen in the extension. The watch stays on and the pairing stays in the
      // URL, so finishing there moves this page along.
      setNeedsAccess({ service: result.service ?? serviceId, domains: result.domains ?? [] });
      return;
    }
    // The pairing is still usable from the popup, so the watch carries on; pressing the button
    // again starts a fresh one.
    setError(result.error ?? "The extension could not send the session.");
  }

  const PHASES: Record<string, string> = {
    starting: "Asking the extension…",
    reading: "Reading your cookies…",
    sending: "Sending them to this instance…",
    saving: "Saving the session…",
  };

  const links = browser === "firefox" ? ["firefox", "chrome"] : ["chrome", "firefox"];
  const phaseText = phase ? (PHASES[phase] ?? null) : null;

  return (
    <div className="uc-card" style={{ display: "grid", gap: 10 }}>
      <div>
        <strong>Use the browser extension</strong>
        <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
          Sends your session straight here, with no copying and pasting. Your cookies go from your
          browser to this instance and nowhere else.
        </div>
      </div>

      {connected ? (
        <p role="status" style={{ margin: 0, fontSize: 14 }}>
          <strong>{connected.reconnected ? "Reconnected." : "Connected."}</strong>{" "}
          {connected.cookieCount ?? 0} cookies received
          {connected.hosts && connected.hosts.length > 0 && <> ({connected.hosts.join(", ")})</>}.
          Taking you to the dashboard…
        </p>
      ) : !armed || bridge ? (
        <>
          <button type="button" onClick={arm} disabled={busy}>
            {busy
              ? phaseText || "Working…"
              : error
                ? "Try again"
                : bridge
                  ? `Connect ${serviceId} now`
                  : "Set up with the extension"}
          </button>

          {bridge && !busy && phaseText && (
            <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--uc-text-muted)" }}>
              {phaseText}
            </p>
          )}

          {bridge && !busy && !phaseText && !needsAccess && !error && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--uc-text-muted)" }}>
              The extension is connected to this instance — one press does the rest.
            </p>
          )}

          {needsAccess && (
            <div className="uc-warning" style={{ fontSize: 14 }}>
              <strong>The extension needs your permission first.</strong>
              <div style={{ marginTop: 4 }}>
                It cannot read {needsAccess.service} cookies until you allow it
                {needsAccess.domains.length > 0 && <> for {needsAccess.domains.join(", ")}</>}. A
                page is not allowed to ask on its behalf, so this one step happens in the
                extension: click its icon in the toolbar, press{" "}
                <strong>Send to this instance</strong> and accept the prompt. Stay on this page —
                it carries on by itself afterwards.
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <ol
            style={{
              margin: 0,
              paddingLeft: 20,
              fontSize: 14,
              lineHeight: 1.8,
              color: "var(--uc-text-muted)",
            }}
          >
            <li>
              Make sure you are signed in to <strong>{serviceId}</strong> in another tab.
            </li>
            <li>
              Come back to <strong>this tab</strong> and click the Universal Claimer icon in your
              toolbar.
            </li>
            <li>
              Click <strong>Send to this instance</strong>.
            </li>
          </ol>
          <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--uc-text-muted)" }}>
            {phaseText ??
              "Waiting for the extension… stay on this page, it moves on by itself. The pairing " +
                "is good for ten minutes and can only be used once."}
          </p>
        </>
      )}

      {error && (
        <p role="alert" style={{ color: "var(--uc-danger)", margin: 0, fontSize: 14 }}>
          {error}
        </p>
      )}

      <details style={{ fontSize: 13 }}>
        <summary style={{ cursor: "pointer", color: "var(--uc-text-muted)" }}>
          Don&apos;t have the extension?
        </summary>
        <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
          {links.map((b) => (
            <a key={b} href={STORES[b as keyof typeof STORES]} target="_blank" rel="noreferrer">
              Install for {b === "firefox" ? "Firefox" : "Chrome / Edge"}
            </a>
          ))}
          <span style={{ color: "var(--uc-text-muted)" }}>
            Or fill in the form below by hand — the extension only saves you the copy and paste.
          </span>
        </div>
      </details>
    </div>
  );
}
