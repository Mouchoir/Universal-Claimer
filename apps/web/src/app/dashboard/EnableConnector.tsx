"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Turn an auto-disabled connector back on. The health monitor disables a connector after repeated
 * failures, which is correct — but the operator needs a way back once the cause is fixed,
 * otherwise the service is stuck off with no recourse.
 */
export function EnableConnector({ serviceId, reason }: { serviceId: string; reason: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/services/${serviceId}/enable`, { method: "POST" });
      if (res.ok) router.refresh();
      else setError("Could not re-enable this connector.");
    } catch {
      setError("Could not re-enable this connector.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <p className="uc-warning" style={{ fontSize: 13, margin: "0 0 6px" }}>
        Automatic runs are paused for this service after repeated failures ({reason}). Fix the
        cause — usually reconnecting the account — then turn it back on. Past failures stop
        counting, so it gets a clean slate.
      </p>
      <button onClick={enable} disabled={busy} style={{ width: "auto", padding: "4px 10px" }}>
        {busy ? "Re-enabling…" : "Re-enable connector"}
      </button>
      {error && (
        <span style={{ color: "var(--uc-danger)", fontSize: 13, marginLeft: 8 }}>{error}</span>
      )}
    </div>
  );
}
