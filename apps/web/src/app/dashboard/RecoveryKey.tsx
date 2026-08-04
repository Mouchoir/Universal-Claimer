"use client";

import { useState } from "react";
import { PasswordInput } from "@/components/secret-inputs";

/**
 * Shows the deployment's encryption key so it can be archived.
 *
 * It is generated on first boot and lives on a volume, which means it exists nowhere the operator
 * has ever seen. That is fine right up until the volume is lost, at which point the database is
 * intact and permanently unreadable. Copying the key into a password manager is the only thing
 * that makes that situation recoverable, and nothing prompts for it unless this exists.
 *
 * Collapsed by default and behind the admin password: it is a thing you do once, not a thing that
 * should be sitting on screen every time the dashboard is open.
 */
export function RecoveryKey() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/recovery-key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setKey((await res.json()).key);
        setPassword("");
        return;
      }
      const data = await res.json().catch(() => null);
      setError(
        data?.error?.code === "RATE_LIMITED"
          ? "Too many attempts. Try again in a few minutes."
          : "Incorrect password.",
      );
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    // Do not leave the key on screen for the next person to open the dashboard.
    setOpen(false);
    setKey(null);
    setPassword("");
    setError(null);
    setCopied(false);
  }

  return (
    <div className="uc-card" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <strong>Encryption key</strong>
          <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
            Back this up with your database. Either one alone is useless.
          </div>
        </div>
        <button type="button" className="uc-quiet" onClick={() => (open ? close() : setOpen(true))}>
          {open ? "Close" : "Show key"}
        </button>
      </div>

      {open && key === null && (
        <form onSubmit={reveal} style={{ display: "grid", gap: 8 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
            <span>Confirm your admin password</span>
            <PasswordInput value={password} onChange={setPassword} required autoFocus />
          </label>
          {error && <p style={{ color: "var(--uc-danger)", margin: 0, fontSize: 14 }}>{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? "Checking…" : "Reveal"}
          </button>
        </form>
      )}

      {key !== null && (
        <div style={{ display: "grid", gap: 8 }}>
          <code
            style={{
              wordBreak: "break-all",
              background: "var(--uc-bg)",
              border: "1px solid var(--uc-border)",
              borderRadius: "var(--uc-radius)",
              padding: 10,
              fontSize: 13,
            }}
          >
            {key}
          </code>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="uc-quiet"
              onClick={() => {
                void navigator.clipboard.writeText(key).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="uc-quiet" onClick={close}>
              Done
            </button>
          </div>
          <p className="uc-warning" style={{ fontSize: 13, margin: 0 }}>
            Store this in your password manager. Restoring a backup of the database needs this
            exact value — every saved account session was encrypted with it, and there is no way
            to recover them without it.
          </p>
        </div>
      )}
    </div>
  );
}
