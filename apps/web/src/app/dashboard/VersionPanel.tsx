"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two things that share a data source and nothing else.
 *
 * "What's new" is the note for the version now running, shown once and then dismissed for good —
 * recorded server-side, so it does not reappear on another machine and does not appear twice on
 * the same one.
 *
 * "Update available" is everything newer than what is running. It only offers a button when the
 * deployment can actually apply one; otherwise it says so rather than presenting a control that
 * does nothing.
 *
 * The button follows the update through rather than firing and forgetting. It used to leave
 * "Updating…" on screen whatever happened — including when there was nothing to install because
 * the updater had already done it overnight, which a dashboard left open could not know. Now the
 * page watches the running version until it changes, reloads onto it, and otherwise says what
 * happened instead.
 */

interface Release {
  version: string;
  notes: string;
  publishedAt: string;
}

interface VersionState {
  running: string;
  available: Release[];
  unseen: Release[];
  canUpdate: boolean;
  /** The release list could not be refreshed, so "no update" is not a claim worth making. */
  checkFailed?: boolean;
  checkError?: string;
}

/** How often, while an update is running, the page asks which version is up. */
const WATCH_EVERY_MS = 3000;
/** How long an update may take before the page stops waiting and says so. */
const WATCH_FOR_MS = 10 * 60 * 1000;
/** A tab left open re-checks when it comes back into view, but not more often than this. */
const RECHECK_AFTER_MS = 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readVersion(): Promise<VersionState | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    return res.ok ? ((await res.json()) as VersionState) : null;
  } catch {
    return null;
  }
}

interface Props {
  /** Test seams. */
  watchEveryMs?: number;
  watchForMs?: number;
  reload?: () => void;
}

export function VersionPanel({
  watchEveryMs = WATCH_EVERY_MS,
  watchForMs = WATCH_FOR_MS,
  reload = () => window.location.reload(),
}: Props = {}) {
  const [state, setState] = useState<VersionState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastChecked = useRef(0);
  const alive = useRef(true);
  /** The version this page was loaded on. The page's own code belongs to it. */
  const loadedVersion = useRef<string | null>(null);
  // Held in a ref so the check below keeps one identity across renders. The default `reload` is a
  // new function every render, and as a dependency it re-ran the effect that calls this — which
  // fetched the version in a loop.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const refresh = useCallback(async () => {
    lastChecked.current = Date.now();
    const next = await readVersion();
    if (!alive.current || !next) return next;
    if (loadedVersion.current === null) {
      loadedVersion.current = next.running;
    } else if (next.running !== loadedVersion.current) {
      // Updated underneath this page — by the updater's schedule, or another tab. What is on
      // screen was built for the old version, so reload rather than patch it.
      reloadRef.current();
      return next;
    }
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // A dashboard left open is exactly the one that goes stale: the updater also installs on its
    // own schedule, and a page loaded before that went on offering what was already installed.
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastChecked.current > RECHECK_AFTER_MS) {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  async function markSeen() {
    setDismissed(true);
    await fetch("/api/version/seen", { method: "POST" }).catch(() => undefined);
  }

  async function applyUpdate() {
    if (!state) return;
    setUpdating(true);
    setError(null);
    setNotice(null);
    setProgress("Asking the updater…");

    // The server's word on what is running, not this page's: a page left open is exactly the one
    // whose idea of that is out of date.
    const fresh = await readVersion();
    let baseline = fresh?.running ?? state.running;
    let target: string | undefined;

    try {
      const res = await fetch("/api/version/update", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok && data?.error?.code) {
        // The instance's own refusal — not configured, rate limited, the updater said no. Final.
        setError(data.error.message ?? "The update could not be started.");
        setUpdating(false);
        setProgress(null);
        return;
      }
      if (res.ok) {
        if (typeof data?.running === "string") baseline = data.running;
        if (data?.upToDate) {
          // Already installed — by the updater's own schedule, typically. If this page was loaded
          // on an older build, it is the page that is out of date: reload onto what is running.
          if (loadedVersion.current && baseline !== loadedVersion.current) {
            reload();
            return;
          }
          setState((s) => (s ? { ...s, running: baseline, available: [] } : s));
          setUpdating(false);
          setProgress(null);
          setNotice(`Already up to date: ${baseline} is the latest version.`);
          void refresh();
          return;
        }
        if (typeof data?.target === "string") target = data.target;
      }
      // Any other answer — a proxy's 502 or 504 with no envelope of ours — is what this instance
      // going down mid-request looks like from behind a proxy, so it is watched like a dropped
      // connection rather than reported as a failure.
    } catch {
      // The connection dropping is the usual sign of success: the updater stops this container to
      // replace it, and the request goes down with it.
    }

    setProgress(
      `Installing${target ? ` ${target}` : ""}… downloading can take a few minutes, and the page ` +
        "goes quiet while the instance restarts.",
    );
    const started = Date.now();
    while (Date.now() - started < watchForMs) {
      await sleep(watchEveryMs);
      if (!alive.current) return;
      const now = await readVersion();
      if (!now) {
        setProgress("Restarting on the new version…");
        continue;
      }
      if (now.running !== baseline) {
        setProgress(`Updated to ${now.running}. Reloading…`);
        // A reload, not a state update: the page itself is part of what changed.
        reload();
        return;
      }
    }
    setUpdating(false);
    setProgress(null);
    // Not "failed": the updater may still be downloading, or may have found nothing to do because
    // another run held it. Its log says which, and this page reloads by itself once it changes.
    setError(
      `Still running ${baseline} after ${Math.round(watchForMs / 60000)} minutes. The updater may ` +
        "still be downloading, or have had nothing to do; its log says which. This page picks up " +
        "the new version by itself when it lands.",
    );
  }

  if (!state) return null;

  const showNotes = !dismissed && state.unseen.length > 0;
  const hasUpdate = state.available.length > 0;
  // Silence means "nothing to report". A failed check has something to report: that it does not
  // know. Saying nothing there is how an instance sat a release behind while looking current.
  const showCheckFailed = state.checkFailed && !hasUpdate;
  if (!showNotes && !hasUpdate && !showCheckFailed && !notice && !error) return null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {showNotes && (
        <div className="uc-card" style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <strong>What&apos;s new in {state.running}</strong>
            <button type="button" className="uc-quiet" onClick={markSeen}>
              Got it
            </button>
          </div>
          {state.unseen.map((r) => (
            <div key={r.version} style={{ fontSize: 14 }}>
              {state.unseen.length > 1 && (
                <div style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>{r.version}</div>
              )}
              <div style={{ whiteSpace: "pre-wrap" }}>{r.notes || "No notes for this version."}</div>
            </div>
          ))}
        </div>
      )}

      {showCheckFailed && (
        <div className="uc-card">
          <strong>Could not check for updates</strong>
          <div style={{ color: "var(--uc-text-muted)", fontSize: 14, marginTop: 4 }}>
            Running {state.running}. The release list could not be reached, so there may be a
            newer version this does not know about
            {state.checkError ? ` (${state.checkError})` : ""}. The updater still installs new
            versions on its own schedule.
          </div>
        </div>
      )}

      {notice && !hasUpdate && (
        <div className="uc-card" role="status" style={{ fontSize: 14 }}>
          {notice}
        </div>
      )}

      {(hasUpdate || (error && !hasUpdate)) && (
        <div className="uc-card" style={{ display: "grid", gap: 8 }}>
          {hasUpdate && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div>
                <strong>
                  Update available — {state.available.length} new{" "}
                  {state.available.length === 1 ? "version" : "versions"}
                </strong>
                <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
                  Running {state.running}, latest {state.available[0]!.version}
                </div>
              </div>
              {state.canUpdate && (
                <button type="button" onClick={applyUpdate} disabled={updating}>
                  {updating ? "Updating…" : "Update now"}
                </button>
              )}
            </div>
          )}

          {hasUpdate && (
            <details style={{ fontSize: 14 }}>
              <summary style={{ cursor: "pointer", color: "var(--uc-text-muted)" }}>
                What changes
              </summary>
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {state.available.map((r) => (
                  <div key={r.version}>
                    <div style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>{r.version}</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{r.notes || "No notes."}</div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {hasUpdate && !state.canUpdate && (
            <p style={{ color: "var(--uc-text-muted)", fontSize: 13, margin: 0 }}>
              To update from here, set <code>UPDATE_WEBHOOK_URL</code> to a Portainer stack
              webhook. Otherwise redeploy the stack yourself — the image tag is unchanged.
            </p>
          )}
          {progress && (
            <p role="status" style={{ color: "var(--uc-text-muted)", margin: 0, fontSize: 13 }}>
              {progress}
            </p>
          )}
          {error && (
            <p role="alert" style={{ color: "var(--uc-danger)", margin: 0, fontSize: 14 }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
