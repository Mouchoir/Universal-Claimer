"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnswerInput, PasswordInput } from "@/components/secret-inputs";

interface RecoveryPrompt {
  position: number;
  question: string;
}

export default function RecoverPage() {
  const router = useRouter();
  const [prompts, setPrompts] = useState<RecoveryPrompt[] | null>(null);
  const [recoveryEnabled, setRecoveryEnabled] = useState(true);
  const [answers, setAnswers] = useState(["", "", ""]);
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Without the questions on screen there is nothing to answer: the form was three anonymous
  // "Answer N" boxes, so the only way to reset was to remember the order they were created in.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/recovery-questions")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setRecoveryEnabled(Boolean(data?.enabled));
        setPrompts(data?.questions ?? []);
      })
      .catch(() => {
        if (!cancelled) setPrompts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      const code = data?.error?.code;
      setError(
        code === "RECOVERY_DISABLED"
          ? "Recovery is not enabled. Use the host-side reset-admin command."
          : code === "RATE_LIMITED"
            ? "Too many attempts. Try again in a few minutes."
            : "One or more answers are incorrect.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (prompts === null) {
    return (
      <main>
        <h1>Reset password</h1>
        <p style={{ color: "var(--uc-text-muted)" }}>Loading your security questions…</p>
      </main>
    );
  }

  if (!recoveryEnabled) {
    return (
      <main>
        <h1>Reset password</h1>
        <div className="uc-card" style={{ marginTop: 16, display: "grid", gap: 16 }}>
          <p className="uc-warning">
            Password recovery was not enabled during setup, so there are no security questions to
            answer. Reset the password from the host instead:
          </p>
          <pre style={{ margin: 0, overflowX: "auto" }}>
            <code>
              docker compose exec app corepack pnpm --filter @uc/web reset-admin
            </code>
          </pre>
          <Link href="/login">Back to sign in</Link>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Reset password</h1>
      <p style={{ color: "var(--uc-text-muted)" }}>
        Answer your three security questions. Answers are not case-sensitive.
      </p>
      <form className="uc-card" style={{ marginTop: 16, display: "grid", gap: 16 }} onSubmit={submit}>
        {prompts.map((prompt, i) => (
          <label key={prompt.position} style={{ display: "grid", gap: 4 }}>
            <span>{prompt.question}</span>
            <AnswerInput
              value={answers[i] ?? ""}
              required
              onChange={(value) => {
                const next = [...answers];
                next[i] = value;
                setAnswers(next);
              }}
            />
          </label>
        ))}
        <label style={{ display: "grid", gap: 4 }}>
          <span>New password (min 8 characters)</span>
          <PasswordInput
            value={newPassword}
            minLength={8}
            required
            autoComplete="new-password"
            onChange={setNewPassword}
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
