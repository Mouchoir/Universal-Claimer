"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ExtensionSetup } from "./ExtensionSetup";

export default function ConnectPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const serviceId = params.id;

  const [warning, setWarning] = useState<string>("");
  const [configFields, setConfigFields] = useState<
    { key: string; label: string; required: boolean; placeholder?: string; help?: string }[]
  >([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [proxy, setProxy] = useState("");
  const [consented, setConsented] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [method, setMethod] = useState<"session_import" | "credential_totp">("session_import");
  const [cookiesText, setCookiesText] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpSeed, setTotpSeed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isReconnect, setIsReconnect] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Validate required connector config fields client-side; highlight + focus the first empty one. */
  function validateConfig(): boolean {
    const errs: Record<string, string> = {};
    for (const f of configFields) {
      if (f.required && !(config[f.key] ?? "").trim()) errs[f.key] = `${f.label} is required.`;
    }
    setFieldErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) {
      const el = document.getElementById(`cfg-${first}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus();
    }
    return Object.keys(errs).length === 0;
  }

  useEffect(() => {
    fetch(`/api/services/${serviceId}/tos`)
      .then((r) => r.json())
      .then((d) => {
        setWarning(d.warning ?? "");
        setConfigFields(d.configFields ?? []);
        // Reconnecting an existing account: consent was already accepted, and its config (e.g.
        // the Twitch channel) is carried over so the operator only re-supplies the session.
        if (d.consented) setConsented(true);
        if (d.hasAccount) setIsReconnect(true);
        if (d.existingConfig) setConfig(d.existingConfig);
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
    if (!validateConfig()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/services/${serviceId}/login-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, proxy: proxy || undefined }),
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
    if (!validateConfig()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { serviceId, method, config, proxy: proxy || undefined };
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
      <h1>{isReconnect ? `Reconnect ${serviceId}` : `Connect ${serviceId}`}</h1>
      {isReconnect && (
        <p style={{ color: "var(--uc-text-muted)" }}>
          Supply a fresh session for this account. Its history and schedule are kept.
        </p>
      )}

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
                    id={`cfg-${f.key}`}
                    value={config[f.key] ?? ""}
                    placeholder={f.placeholder}
                    required={f.required}
                    aria-invalid={fieldErrors[f.key] ? true : undefined}
                    style={
                      fieldErrors[f.key]
                        ? { border: "1px solid var(--uc-danger)", outlineColor: "var(--uc-danger)" }
                        : undefined
                    }
                    onChange={(e) => {
                      setConfig({ ...config, [f.key]: e.target.value });
                      if (fieldErrors[f.key]) {
                        setFieldErrors((prev) => {
                          const next = { ...prev };
                          delete next[f.key];
                          return next;
                        });
                      }
                    }}
                  />
                  {f.help && (
                    <span style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>{f.help}</span>
                  )}
                  {fieldErrors[f.key] && (
                    <span style={{ color: "var(--uc-danger)", fontSize: 13 }}>{fieldErrors[f.key]}</span>
                  )}
                </label>
              ))}
            </div>
          )}

          <div className="uc-card" style={{ marginTop: 16, display: "grid", gap: 4 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span>Proxy (optional)</span>
              <input
                value={proxy}
                placeholder="http://user:pass@host:port or socks5://host:port"
                onChange={(e) => setProxy(e.target.value)}
              />
            </label>
            <span style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>
              Route this account through its own proxy so accounts don&apos;t share one IP.
              Stored encrypted. Leave empty to use this host&apos;s IP.
            </span>
          </div>

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

          <div style={{ marginTop: 16 }}>
            <ExtensionSetup
              serviceId={serviceId}
              config={config}
              onConnected={() => router.push("/dashboard")}
            />
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
