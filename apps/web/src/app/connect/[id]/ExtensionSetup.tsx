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
 */

const STORES = {
  firefox: "https://addons.mozilla.org/firefox/addon/universal-claimer-exporter/",
  // Published from the same source; the id is fixed once the listing exists.
  chrome: "https://chromewebstore.google.com/detail/mlnemnpdpmafkadcgcipbncmbkmjpgjf",
};

/** Which store to lead with. Only ever used to order two links that are both always shown. */
function likelyBrowser(): "firefox" | "chrome" {
  if (typeof navigator === "undefined") return "chrome";
  return /firefox/i.test(navigator.userAgent) ? "firefox" : "chrome";
}

interface Props {
  serviceId: string;
  config: Record<string, string>;
  /** Called once the session has landed, so the page can move on. */
  onConnected: () => void;
}

export function ExtensionSetup({ serviceId, config, onConnected }: Props) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<"firefox" | "chrome">("chrome");
  /** Set once the extension's bridge announces itself, which only happens on an allowed origin. */
  const [bridge, setBridge] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => setBrowser(likelyBrowser()), []);

  // Listen for the bridge, and ask for it: the content script announces on load, which may have
  // been before this component mounted.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type === "uc-extension-ready") setBridge(true);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ type: "uc-extension-ready?" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  async function arm() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/connect/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId, config }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error?.message ?? "Could not start the pairing.");
        return;
      }
      const { token } = await res.json();

      // With the bridge present this is genuinely one click: hand the token straight to the
      // extension and wait for its answer, rather than explaining a three-step dance.
      if (bridge) {
        const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
          const onResult = (event: MessageEvent) => {
            if (event.source !== window || event.origin !== window.location.origin) return;
            if (event.data?.type !== "uc-extension-result") return;
            window.removeEventListener("message", onResult);
            resolve(event.data);
          };
          window.addEventListener("message", onResult);
        });
        // The URL still has to carry the token: the extension re-derives it from the tab to
        // refuse a page asking for a pairing it was not issued.
        const armedUrl = new URL(window.location.href);
        armedUrl.searchParams.set("pair", token);
        window.history.replaceState(null, "", armedUrl.toString());

        window.postMessage(
          { type: "uc-extension-connect", token, serviceId },
          window.location.origin,
        );
        const result = await done;
        if (result.ok) {
          onConnected();
          return;
        }
        setError(result.error ?? "The extension could not send the session.");
        return;
      }

      // The token goes in the URL because that is the one thing the extension can read without
      // any permission on this origin. replaceState rather than a navigation: reloading would
      // throw away the React state the operator just filled in.
      const url = new URL(window.location.href);
      url.searchParams.set("pair", token);
      window.history.replaceState(null, "", url.toString());
      setArmed(true);

      // The extension posts straight to the API, so nothing tells this page it happened.
      pollRef.current = setInterval(async () => {
        const check = await fetch("/api/services").catch(() => null);
        if (!check?.ok) return;
        const { services } = await check.json();
        if (services?.find((s: { id: string }) => s.id === serviceId)?.connected) {
          stopPolling();
          onConnected();
        }
      }, 2000);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const links = browser === "firefox" ? ["firefox", "chrome"] : ["chrome", "firefox"];

  return (
    <div className="uc-card" style={{ display: "grid", gap: 10 }}>
      <div>
        <strong>Use the browser extension</strong>
        <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
          Sends your session straight here, with no copying and pasting. Your cookies go from your
          browser to this instance and nowhere else.
        </div>
      </div>

      {!armed ? (
        <>
          <button type="button" onClick={arm} disabled={busy}>
            {busy
              ? bridge
                ? "Fetching your session…"
                : "Preparing…"
              : bridge
                ? `Connect ${serviceId} now`
                : "Set up with the extension"}
          </button>
          {bridge && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--uc-text-muted)" }}>
              The extension is connected to this instance — one press does the rest.
            </p>
          )}
          {error && <p style={{ color: "var(--uc-danger)", margin: 0, fontSize: 14 }}>{error}</p>}
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
            <li>Click the Universal Claimer icon in your toolbar.</li>
            <li>
              Click <strong>Send to this instance</strong>.
            </li>
          </ol>
          <p style={{ margin: 0, fontSize: 13, color: "var(--uc-text-muted)" }}>
            Waiting for the extension… this page will move on by itself. The pairing is good for
            ten minutes and can only be used once.
          </p>
        </>
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
