"use client";

import { useEffect, useState } from "react";

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
}

export function VersionPanel() {
  const [state, setState] = useState<VersionState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setState(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  async function markSeen() {
    setDismissed(true);
    await fetch("/api/version/seen", { method: "POST" }).catch(() => undefined);
  }

  async function applyUpdate() {
    setUpdating(true);
    setError(null);
    try {
      const res = await fetch("/api/version/update", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error?.message ?? "The update could not be started.");
        setUpdating(false);
      }
      // On success the stack is redeploying and this page is about to lose its server. Leaving
      // the button in its busy state is the honest rendering of that.
    } catch {
      // The redeploy usually kills the connection before the response arrives, which is success
      // rather than failure — so this is not reported as an error.
    }
  }

  if (!state) return null;

  const showNotes = !dismissed && state.unseen.length > 0;
  const hasUpdate = state.available.length > 0;
  if (!showNotes && !hasUpdate) return null;

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

      {hasUpdate && (
        <div className="uc-card" style={{ display: "grid", gap: 8 }}>
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

          {!state.canUpdate && (
            <p style={{ color: "var(--uc-text-muted)", fontSize: 13, margin: 0 }}>
              To update from here, set <code>UPDATE_WEBHOOK_URL</code> to a Portainer stack
              webhook. Otherwise redeploy the stack yourself — the image tag is unchanged.
            </p>
          )}
          {error && <p style={{ color: "var(--uc-danger)", margin: 0, fontSize: 14 }}>{error}</p>}
          {updating && (
            <p style={{ color: "var(--uc-text-muted)", margin: 0, fontSize: 13 }}>
              The stack is redeploying. This page will be unreachable for a minute or two, then
              come back on the new version.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
