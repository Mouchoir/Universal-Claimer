"use client";

import { useEffect, useState } from "react";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduleEditor({
  accountId,
  schedulingMode = "recurring",
  benefitEndsAt,
}: {
  accountId: string;
  /**
   * `on_expiry` services (a Twitch Prime sub) renew when the current benefit runs out, so a
   * daily/weekly slot is meaningless for them and the editor hides it.
   */
  schedulingMode?: "recurring" | "on_expiry";
  /** End of the active benefit, shown so the operator knows when the run will happen. */
  benefitEndsAt?: string;
}) {
  const onExpiry = schedulingMode === "on_expiry";
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<"daily" | "weekly" | "on_expiry">(
    onExpiry ? "on_expiry" : "daily",
  );
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [jitterMinutes, setJitterMinutes] = useState(0);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const [hasSchedule, setHasSchedule] = useState(false);

  useEffect(() => {
    fetch(`/api/accounts/${accountId}/schedule`)
      .then((r) => r.json())
      .then((d) => {
        const s = d.schedule;
        if (!s) return;
        setHasSchedule(true);
        setEnabled(s.enabled);
        setFrequency(s.frequency);
        setDayOfWeek(s.dayOfWeek ?? 1);
        setHour(s.hour);
        setMinute(s.minute);
        setJitterMinutes(s.jitterMinutes ?? 0);
        setNextRunAt(s.nextRunAt ?? null);
      })
      .catch(() => undefined);
  }, [accountId]);


  async function save() {
    setMsg(null);
    const body = {
      frequency,
      hour,
      minute,
      dayOfWeek: frequency === "weekly" ? dayOfWeek : null,
      enabled,
      jitterMinutes,
    };
    const res = await fetch(`/api/accounts/${accountId}/schedule`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const d = await res.json();
      setNextRunAt(d.nextRunAt ?? null);
      setHasSchedule(true);
      setMsg(enabled ? "Schedule saved." : "Scheduling disabled.");
      setMsgIsError(false);
    } else {
      // Surface the server's reason (e.g. a value out of range) instead of a generic failure.
      const d = await res.json().catch(() => null);
      setMsg(d?.error?.message ?? "Could not save the schedule.");
      setMsgIsError(true);
    }
  }

  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6, fontSize: 14 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Run automatically</span>
      </label>

      {/* Expiry-driven services renew when the current benefit ends — no clock slot to pick. */}
      {enabled && onExpiry && (
        <span style={{ color: "var(--uc-text-muted)" }}>
          Renews when the current benefit runs out
          {benefitEndsAt ? <> — {new Date(benefitEndsAt).toLocaleString()}</> : " (date not known yet)"}.
        </span>
      )}

      {enabled && !onExpiry && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as "daily" | "weekly")} style={{ width: "auto" }}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
          {frequency === "weekly" && (
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))} style={{ width: "auto" }}>
              {DAYS.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          )}
          <span>at</span>
          <input
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            style={{ width: 60 }}
          />
          <span>:</span>
          <input
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(e) => setMinute(Number(e.target.value))}
            style={{ width: 60 }}
          />
          <span style={{ color: "var(--uc-text-muted)" }}>({pad(hour)}:{pad(minute)} local)</span>
        </div>
      )}

      {enabled && (
        <>
          <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>{onExpiry ? "Delay by up to" : "Randomize by ±"}</span>
            <input
              type="number"
              min={0}
              max={1440}
              value={jitterMinutes}
              onChange={(e) => setJitterMinutes(Number(e.target.value))}
              style={{ width: 70 }}
            />
            <span>minutes</span>
          </label>
          <span style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>
            {onExpiry ? (
              <>
                Waits a random moment within this window after the benefit expires, so the renewal
                never happens at the exact same second every month. Never earlier than the expiry
                (renewing before it ends would fail). Up to 1440 (24h); 0 renews immediately.
              </>
            ) : (
              <>
                Each run lands at a different time so the automation never fires at an identical
                hour — an obvious pattern to the services. Up to 1440 (±24h); 0 disables it.
                {jitterMinutes >= 720 && (
                  <> With a window this wide, two runs can fall up to a day apart.</>
                )}
              </>
            )}
          </span>
        </>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={save} style={{ padding: "4px 10px" }}>
          Save schedule
        </button>
        {nextRunAt && enabled && (
          <span style={{ color: "var(--uc-text-muted)" }}>
            Next: {new Date(nextRunAt).toLocaleString()}
          </span>
        )}
        {msg && (
          <span style={{ color: msgIsError ? "var(--uc-danger)" : "var(--uc-success)" }}>{msg}</span>
        )}
      </div>
    </div>
  );
}
