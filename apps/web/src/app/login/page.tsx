"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PasswordInput } from "@/components/secret-inputs";

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
        // refresh() as well as push(): the dashboard is a server component that reads the
        // session cookie, and the client router would otherwise be free to serve a cached
        // pre-login render of it.
        router.refresh();
        router.push("/dashboard");
        return;
      }
      const data = await res.json().catch(() => null);
      setError(
        data?.error?.code === "RATE_LIMITED"
          ? "Too many attempts. Try again in a few minutes."
          : "Incorrect password.",
      );
    } catch {
      // Anything that is not an HTTP response at all — server down, connection dropped. Without
      // this the promise rejected, the form reset itself, and clicking Sign in looked like it
      // did nothing whatsoever.
      setError("Could not reach the server. Check that the app container is running.");
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
          <PasswordInput value={password} required autoFocus onChange={setPassword} />
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
