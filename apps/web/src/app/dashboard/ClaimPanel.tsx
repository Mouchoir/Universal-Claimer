"use client";

import { useEffect, useState } from "react";
import { ScheduleEditor } from "./ScheduleEditor";

interface Entitlement {
  kind: string;
  channel?: string;
  endsAt?: string;
  /** True when endsAt was derived from our claim history rather than reported by the service. */
  endsAtEstimated?: boolean;
}
interface ClaimEvent {
  kind: string;
  title: string;
  claimedAt: string;
}
interface Account {
  id: string;
  serviceId: string;
  method: string;
  status: string;
  displayName?: string | null;
  config?: Record<string, string>;
  facts?: { entitlements?: Entitlement[] };
  recentClaims?: ClaimEvent[];
}

/** Format an ISO date for display, or null when it's missing/unparseable. */
function formatDate(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Whole days from now until `iso` (negative when past); null when unknown. */
function daysUntil(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}
interface Job {
  id: string;
  serviceId: string;
  state: string;
  outcome: string | null;
  summary: string | null;
}

const OUTCOME_COLOR: Record<string, string> = {
  claimed: "var(--uc-success)",
  nothing_to_claim: "var(--uc-text-muted)",
  failed: "var(--uc-danger)",
  reauth_needed: "var(--uc-warning)",
};

export function ClaimPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d) => setAccounts(d.accounts ?? []))
      .catch(() => setAccounts([]));

    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "jobs") setJobs(data.jobs ?? []);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, []);

  async function runClaim(accountId: string) {
    setMsg(null);
    const res = await fetch(`/api/accounts/${accountId}/claim`, { method: "POST" });
    if (res.status === 409) setMsg("A claim is already running for this account.");
    else if (!res.ok) setMsg("Could not start the claim.");
  }

  async function resume(jobId: string) {
    setMsg(null);
    const res = await fetch(`/api/jobs/${jobId}/human-action`, { method: "POST" });
    if (!res.ok) setMsg("Could not resume the job.");
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Connected accounts</h2>
      {accounts.length === 0 ? (
        <p style={{ color: "var(--uc-text-muted)" }}>No accounts connected yet.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {accounts.map((a) => (
            <div key={a.id} className="uc-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>{a.serviceId}</strong>
                  {a.displayName && (
                    <span style={{ marginLeft: 8, color: "var(--uc-text)" }}>
                      · {a.displayName}
                    </span>
                  )}
                  <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
                    {a.method} — {a.status}
                    {a.config?.channel && <> · channel: {a.config.channel}</>}
                  </div>
                </div>
                <button onClick={() => runClaim(a.id)}>Run claim</button>
              </div>

              {/* Active benefits (e.g. a Twitch Prime sub and when it runs out). */}
              {a.facts?.entitlements?.map((e, i) => {
                const ends = formatDate(e.endsAt);
                const left = daysUntil(e.endsAt);
                return (
                  <div key={i} style={{ marginTop: 8, fontSize: 14 }}>
                    <span style={{ color: "var(--uc-success)" }}>●</span>{" "}
                    {e.kind === "prime_sub" ? "Prime sub" : e.kind}
                    {e.channel && <> to <strong>{e.channel}</strong></>}
                    {ends ? (
                      <span style={{ color: "var(--uc-text-muted)" }}>
                        {" "}
                        — ends {e.endsAtEstimated ? "~" : ""}
                        {ends}
                        {left !== null && left >= 0 && <> ({left} day{left === 1 ? "" : "s"} left)</>}
                        {e.endsAtEstimated && (
                          <span title="Twitch no longer exposes the exact date; estimated from when we claimed it (Prime subs last 30 days).">
                            {" "}
                            (est.)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "var(--uc-text-muted)" }}> — active</span>
                    )}
                  </div>
                );
              })}

              {/* What this account has actually obtained, most recent first. */}
              {a.recentClaims && a.recentClaims.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 14 }}>
                  <span style={{ color: "var(--uc-text-muted)" }}>Recently claimed: </span>
                  {a.recentClaims.map((c, i) => (
                    <span key={i}>
                      {i > 0 && ", "}
                      {c.title}
                      <span style={{ color: "var(--uc-text-muted)" }}>
                        {" "}
                        ({formatDate(c.claimedAt) ?? "—"})
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <ScheduleEditor
                accountId={a.id}
                suggestedNextRun={a.facts?.entitlements?.find((e) => e.endsAt)?.endsAt}
              />
            </div>
          ))}
        </div>
      )}
      {msg && <p style={{ color: "var(--uc-warning)" }}>{msg}</p>}

      <h2 style={{ marginTop: 24 }}>Recent jobs</h2>
      {jobs.length === 0 ? (
        <p style={{ color: "var(--uc-text-muted)" }}>No jobs yet.</p>
      ) : (
        <ul>
          {jobs.map((j) => (
            <li key={j.id}>
              <strong>{j.serviceId}</strong> — {j.state}
              {j.outcome && (
                <span style={{ color: OUTCOME_COLOR[j.outcome] ?? "inherit" }}> ({j.outcome})</span>
              )}
              {j.summary && <span style={{ color: "var(--uc-text-muted)" }}> — {j.summary}</span>}
              {j.state === "requires_human_action" && (
                <div style={{ marginTop: 4 }}>
                  <span className="uc-warning">
                    Complete the challenge in your own browser, then resume.
                  </span>{" "}
                  <button onClick={() => resume(j.id)}>I&apos;ve solved it — resume</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
