"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface QA {
  question: string;
  answer: string;
}

const EMPTY_QA: QA[] = [
  { question: "", answer: "" },
  { question: "", answer: "" },
  { question: "", answer: "" },
];

export default function SetupPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [enableRecovery, setEnableRecovery] = useState(false);
  const [questions, setQuestions] = useState<QA[]>(EMPTY_QA);
  const [enableWebhook, setEnableWebhook] = useState(false);
  const [webhookKind, setWebhookKind] = useState("discord");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { password };
      if (enableRecovery) body.recovery = questions;
      if (enableWebhook) body.webhook = { kind: webhookKind, url: webhookUrl };
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.push("/dashboard");
        return;
      }
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Setup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Welcome — first-run setup</h1>
      <p style={{ color: "var(--uc-text-muted)" }}>
        This deployment is for a single operator. Set your admin password below.
      </p>

      <form className="uc-card" style={{ marginTop: 16, display: "grid", gap: 16 }} onSubmit={submit}>
        <label style={{ display: "grid", gap: 4 }}>
          <span>Admin password (min 8 characters)</span>
          <input
            type="password"
            value={password}
            minLength={8}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={enableRecovery}
            onChange={(e) => setEnableRecovery(e.target.checked)}
          />
          <span>Enable password recovery with 3 security questions</span>
        </label>

        {!enableRecovery && (
          <p className="uc-warning">
            Without recovery questions, a forgotten password can only be reset with the
            host-side command (<code>reset-admin</code>).
          </p>
        )}

        {enableRecovery &&
          questions.map((qa, i) => (
            <div key={i} style={{ display: "grid", gap: 4 }}>
              <input
                placeholder={`Security question ${i + 1}`}
                value={qa.question}
                required
                onChange={(e) => {
                  const next = [...questions];
                  next[i] = { ...next[i]!, question: e.target.value };
                  setQuestions(next);
                }}
              />
              <input
                placeholder="Answer"
                value={qa.answer}
                required
                onChange={(e) => {
                  const next = [...questions];
                  next[i] = { ...next[i]!, answer: e.target.value };
                  setQuestions(next);
                }}
              />
            </div>
          ))}

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={enableWebhook}
            onChange={(e) => setEnableWebhook(e.target.checked)}
          />
          <span>Send notifications to a webhook (optional)</span>
        </label>

        {enableWebhook && (
          <div style={{ display: "grid", gap: 4 }}>
            <select value={webhookKind} onChange={(e) => setWebhookKind(e.target.value)}>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
              <option value="ntfy">ntfy</option>
            </select>
            <input
              placeholder="Webhook URL"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>
        )}

        {error && <p style={{ color: "var(--uc-danger)" }}>{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "Setting up…" : "Complete setup"}
        </button>
      </form>
    </main>
  );
}
