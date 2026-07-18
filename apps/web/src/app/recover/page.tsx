"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RecoverPage() {
  const router = useRouter();
  const [answers, setAnswers] = useState(["", "", ""]);
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, newPassword }),
      });
      if (res.ok) {
        router.push("/dashboard");
        return;
      }
      const data = await res.json().catch(() => null);
      setError(
        data?.error?.code === "RECOVERY_DISABLED"
          ? "Recovery is not enabled. Use the host-side reset-admin command."
          : "One or more answers are incorrect.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Reset password</h1>
      <p style={{ color: "var(--uc-text-muted)" }}>Answer your three security questions.</p>
      <form className="uc-card" style={{ marginTop: 16, display: "grid", gap: 16 }} onSubmit={submit}>
        {answers.map((a, i) => (
          <label key={i} style={{ display: "grid", gap: 4 }}>
            <span>Answer {i + 1}</span>
            <input
              value={a}
              required
              onChange={(e) => {
                const next = [...answers];
                next[i] = e.target.value;
                setAnswers(next);
              }}
            />
          </label>
        ))}
        <label style={{ display: "grid", gap: 4 }}>
          <span>New password (min 8 characters)</span>
          <input
            type="password"
            value={newPassword}
            minLength={8}
            required
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        {error && <p style={{ color: "var(--uc-danger)" }}>{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Resetting…" : "Reset password"}
        </button>
        <Link href="/login">Back to sign in</Link>
      </form>
    </main>
  );
}
