"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/dashboard");
        return;
      }
      setError("Incorrect password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form className="uc-card" style={{ marginTop: 16, display: "grid", gap: 16 }} onSubmit={submit}>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Admin password</span>
          <input
            type="password"
            value={password}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p style={{ color: "var(--uc-danger)" }}>{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <Link href="/recover">Forgot your password?</Link>
      </form>
    </main>
  );
}
