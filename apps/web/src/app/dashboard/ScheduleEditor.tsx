"use client";

import { useEffect, useState } from "react";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ScheduleEditor({ accountId }: { accountId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/accounts/${accountId}/schedule`)
      .then((r) => r.json())
      .then((d) => {
        const s = d.schedule;
        if (!s) return;
        setEnabled(s.enabled);
        setFrequency(s.frequency);
        setDayOfWeek(s.dayOfWeek ?? 1);
        setHour(s.hour);
        setMinute(s.minute);
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
    };
    const res = await fetch(`/api/accounts/${accountId}/schedule`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const d = await res.json();
      setNextRunAt(d.nextRunAt ?? null);
      setMsg(enabled ? "Schedule saved." : "Scheduling disabled.");
    } else {
      setMsg("Could not save the schedule.");
    }
  }

  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6, fontSize: 14 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Run automatically</span>
      </label>

      {enabled && (
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

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={save} style={{ padding: "4px 10px" }}>
          Save schedule
        </button>
        {nextRunAt && enabled && (
          <span style={{ color: "var(--uc-text-muted)" }}>
            Next: {new Date(nextRunAt).toLocaleString()}
          </span>
        )}
        {msg && <span style={{ color: "var(--uc-success)" }}>{msg}</span>}
      </div>
    </div>
  );
}
