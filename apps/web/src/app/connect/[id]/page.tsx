"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

export default function ConnectPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const serviceId = params.id;

  const [warning, setWarning] = useState<string>("");
  const [configFields, setConfigFields] = useState<
    { key: string; label: string; required: boolean; placeholder?: string }[]
  >([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [consented, setConsented] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [method, setMethod] = useState<"session_import" | "credential_totp">("session_import");
  const [cookiesText, setCookiesText] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpSeed, setTotpSeed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/services/${serviceId}/tos`)
      .then((r) => r.json())
      .then((d) => {
        setWarning(d.warning ?? "");
        setConfigFields(d.configFields ?? []);
      })
      .catch(() => setWarning(""));
  }, [serviceId]);

  async function giveConsent() {
    setError(null);
    const res = await fetch(`/api/services/${serviceId}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accepted: true }),
    });
    if (res.ok) setConsented(true);
    else setError("Could not record consent.");
  }

  async function startAssisted() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${serviceId}/login-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (res.ok) {
        const data = await res.json();
        router.push(`/login-session/${data.sessionId}`);
        return;
      }
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Could not start assisted login.");
    } finally {
      setBusy(false);
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { serviceId, method, config };
      if (method === "session_import") body.cookiesText = cookiesText;
      else Object.assign(body, { email, password, totpSeed: totpSeed || undefined });

      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.push("/dashboard");
        return;
      }
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Could not connect the account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Connect {serviceId}</h1>

      {!consented ? (
        <div className="uc-card" style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <p className="uc-warning">{warning}</p>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>I understand and accept the risk.</span>
          </label>
          {error && <p style={{ color: "var(--uc-danger)" }}>{error}</p>}
          <button disabled={!accepted} onClick={giveConsent}>
            Continue
          </button>
        </div>
      ) : (
        <>
          {configFields.length > 0 && (
            <div className="uc-card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
              {configFields.map((f) => (
                <label key={f.key} style={{ display: "grid", gap: 4 }}>
                  <span>
                    {f.label}
                    {f.required ? " *" : ""}
                  </span>
                  <input
                    value={config[f.key] ?? ""}
                    placeholder={f.placeholder}
                    required={f.required}
                    onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="uc-card" style={{ marginTop: 16, display: "grid", gap: 8 }}>
            <strong>Log in for me (recommended)</strong>
            <span style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
              We open the official {serviceId} login page in a browser your own instance
              controls. You log in; we capture only the session (stored encrypted) so
              automation can act as you — your password is never kept.
            </span>
            <button onClick={startAssisted} disabled={busy}>
              {busy ? "Starting…" : "Log in for me"}
            </button>
          </div>

          <p style={{ color: "var(--uc-text-muted)", marginTop: 16 }}>Or connect manually:</p>

          <form className="uc-card" style={{ marginTop: 8, display: "grid", gap: 12 }} onSubmit={connect}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Connection method</span>
            <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="session_import">Session import (recommended)</option>
              <option value="credential_totp">Email + password + TOTP</option>
            </select>
          </label>

          {method === "session_import" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span>
                Export your cookies with a &quot;Get cookies.txt&quot; browser extension while
                logged in, then paste the file contents here.
              </span>
              <textarea
                rows={8}
                value={cookiesText}
                onChange={(e) => setCookiesText(e.target.value)}
                placeholder="# Netscape HTTP Cookie File…"
                required
              />
            </label>
          ) : (
            <>
              <input
                type="email"
                placeholder="Email"
                value={email}
                required
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                required
                onChange={(e) => setPassword(e.target.value)}
              />
              <input
                placeholder="TOTP secret (optional)"
                value={totpSeed}
                onChange={(e) => setTotpSeed(e.target.value)}
              />
            </>
          )}

          {error && <p style={{ color: "var(--uc-danger)" }}>{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect account"}
          </button>
        </form>
        </>
      )}
    </main>
  );
}
