"use client";

import { useCallback, useEffect, useState } from "react";

interface ServiceActivity {
  serviceId: string;
  claimedTotal: number;
  claimedRecent: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  lastOutcome: string | null;
  nextRunAt: string | null;
}
interface Summary {
  claimedTotal: number;
  claimedRecent: number;
  totalRuns: number;
  successfulRuns: number;
  services: ServiceActivity[];
}
interface Job {
  id: string;
  serviceId: string;
  state: string;
  trigger?: string;
  outcome: string | null;
  summary: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface Claim {
  id: string;
  serviceId: string;
  kind: string;
  title: string;
  claimedAt: string;
  /** Store the key must be redeemed on, when the item is not delivered in place. */
  platform?: string | null;
  /** Deadline to redeem it — keys stop working when the offer ends. */
  redeemBy?: string | null;
  hasCode?: boolean;
  redeemedAt?: string | null;
}

const OUTCOME_COLOR: Record<string, string> = {
  claimed: "var(--uc-success)",
  nothing_to_claim: "var(--uc-text-muted)",
  failed: "var(--uc-danger)",
  reauth_needed: "var(--uc-warning)",
};

const KIND_LABEL: Record<string, string> = {
  game: "🎮 Game",
  prime_sub: "💜 Prime sub",
  points: "⭐ Points",
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "—";
}

/** Small labelled figure used across the stat row. */
function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="uc-card" style={{ minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 26, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 13, color: "var(--uc-text-muted)" }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--uc-text-muted)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function ActivityView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [perDay, setPerDay] = useState<{ day: string; count: number }[]>([]);
  const [service, setService] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (svc: string | null) => {
    setLoading(true);
    try {
      const qs = svc ? `?service=${encodeURIComponent(svc)}` : "";
      const res = await fetch(`/api/activity${qs}`);
      if (!res.ok) return;
      const d = await res.json();
      setSummary(d.summary ?? null);
      setJobs(d.jobs ?? []);
      setClaims(d.claims ?? []);
      setPerDay(d.perDay ?? []);
    } catch {
      /* leave the last good view in place */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(service);
  }, [load, service]);

  const successRate =
    summary && summary.totalRuns > 0
      ? Math.round((summary.successfulRuns / summary.totalRuns) * 100)
      : null;
  const peak = Math.max(1, ...perDay.map((d) => d.count));

  return (
    <>
      <section style={{ marginTop: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Stat label="Items claimed (all time)" value={summary?.claimedTotal ?? 0} />
          <Stat label="Claimed in the last 30 days" value={summary?.claimedRecent ?? 0} />
          <Stat label="Runs" value={summary?.totalRuns ?? 0} />
          <Stat
            label="Success rate"
            value={successRate === null ? "—" : `${successRate}%`}
            hint={summary ? `${summary.successfulRuns}/${summary.totalRuns} runs` : undefined}
          />
        </div>
      </section>

      {/* Per-service rollup: the "what happened for each service" view. */}
      <section style={{ marginTop: 24 }}>
        <h2>By service</h2>
        {!summary?.services.length ? (
          <p style={{ color: "var(--uc-text-muted)" }}>Nothing has run yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {summary.services.map((s) => (
              <div key={s.serviceId} className="uc-card">
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <strong>{s.serviceId}</strong>
                  <span style={{ color: OUTCOME_COLOR[s.lastOutcome ?? ""] ?? "var(--uc-text-muted)" }}>
                    {s.lastOutcome ?? "no run yet"}
                  </span>
                </div>
                <div style={{ color: "var(--uc-text-muted)", fontSize: 14, marginTop: 4 }}>
                  <strong style={{ color: "var(--uc-text)" }}>{s.claimedTotal}</strong> claimed
                  {s.claimedRecent > 0 && <> ({s.claimedRecent} in 30d)</>} ·{" "}
                  {s.successfulRuns}/{s.totalRuns} runs ok
                  {s.failedRuns > 0 && (
                    <span style={{ color: "var(--uc-danger)" }}> · {s.failedRuns} failed</span>
                  )}
                </div>
                <div style={{ color: "var(--uc-text-muted)", fontSize: 13, marginTop: 4 }}>
                  Last run {fmt(s.lastRunAt)} · Next {s.nextRunAt ? fmt(s.nextRunAt) : "not scheduled"}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Claims per day — a plain CSS bar chart, no dependency needed. */}
      {perDay.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2>Claims over the last 30 days</h2>
          <div
            className="uc-card"
            style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 90 }}
          >
            {perDay.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.count}`}
                style={{
                  flex: 1,
                  minWidth: 4,
                  height: `${(d.count / peak) * 100}%`,
                  background: "var(--uc-primary)",
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Filter applies to both lists below. */}
      <section style={{ marginTop: 24, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>Filter:</span>
        <button
          onClick={() => setService(null)}
          style={{ padding: "2px 10px", width: "auto", opacity: service === null ? 1 : 0.6 }}
        >
          All
        </button>
        {summary?.services.map((s) => (
          <button
            key={s.serviceId}
            onClick={() => setService(s.serviceId)}
            style={{ padding: "2px 10px", width: "auto", opacity: service === s.serviceId ? 1 : 0.6 }}
          >
            {s.serviceId}
          </button>
        ))}
        {loading && <span style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>loading…</span>}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>Claimed items</h2>
        {claims.length === 0 ? (
          <p style={{ color: "var(--uc-text-muted)" }}>
            Nothing claimed yet{service ? ` for ${service}` : ""}.
          </p>
        ) : (
          <div className="uc-card" style={{ display: "grid", gap: 6 }}>
            {claims.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span>
                  {KIND_LABEL[c.kind] ?? c.kind} <strong>{c.title}</strong>
                  <span style={{ color: "var(--uc-text-muted)" }}> · {c.serviceId}</span>
                  {c.platform && (
                    <span style={{ color: "var(--uc-text-muted)" }}> · redeem on {c.platform}</span>
                  )}
                  {c.hasCode && !c.redeemedAt && (
                    <span style={{ color: "var(--uc-warning)" }}> · key to redeem</span>
                  )}
                  {c.redeemBy && (() => {
                    const days = Math.ceil((Date.parse(c.redeemBy) - Date.now()) / 86_400_000);
                    if (!Number.isFinite(days)) return null;
                    // Under a week left is worth a warning colour: an unredeemed key expires.
                    return (
                      <span style={{ color: days <= 7 ? "var(--uc-warning)" : "var(--uc-text-muted)" }}>
                        {" "}· by {new Date(c.redeemBy).toLocaleDateString()}
                        {days >= 0 ? ` (${days}d)` : " (expired)"}
                      </span>
                    );
                  })()}
                </span>
                <span style={{ color: "var(--uc-text-muted)", fontSize: 13, whiteSpace: "nowrap" }}>
                  {fmt(c.claimedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: 24, marginBottom: 32 }}>
        <h2>Run history</h2>
        {jobs.length === 0 ? (
          <p style={{ color: "var(--uc-text-muted)" }}>
            No runs yet{service ? ` for ${service}` : ""}.
          </p>
        ) : (
          <div className="uc-card" style={{ display: "grid", gap: 8 }}>
            {jobs.map((j) => (
              <div key={j.id} style={{ display: "grid", gap: 2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span>
                    <strong>{j.serviceId}</strong>{" "}
                    <span style={{ color: OUTCOME_COLOR[j.outcome ?? ""] ?? "var(--uc-text-muted)" }}>
                      {j.outcome ?? j.state}
                    </span>
                  </span>
                  <span style={{ color: "var(--uc-text-muted)", fontSize: 13, whiteSpace: "nowrap" }}>
                    {j.trigger === "scheduled" ? "auto" : "manual"} · {fmt(j.createdAt)}
                  </span>
                </div>
                {j.summary && (
                  <div style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>{j.summary}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
