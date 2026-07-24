"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

// The worker launches the browser at this fixed viewport (see defaultFingerprint).
const VIEW_W = 1280;
const VIEW_H = 800;

export default function LoginSessionPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<string>("pending");
  const [embedRelay, setEmbedRelay] = useState(false);
  const [frameTick, setFrameTick] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Poll status + refresh the frame.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/login-sessions/${id}`);
        if (res.ok) {
          const data = await res.json();
          if (!alive) return;
          setStatus(data.status);
          setEmbedRelay(Boolean(data.embedRelay));
          if (data.status === "connected") {
            router.push("/dashboard");
            return;
          }
        }
      } catch {
        /* ignore */
      }
      // Frame counter only matters when the embed <img> is mounted (headless relay mode).
      if (alive) setFrameTick((t) => t + 1);
    };
    const iv = setInterval(tick, 900);
    void tick();
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id, router]);

  async function send(event: Record<string, unknown>) {
    await fetch(`/api/login-sessions/${id}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch(() => undefined);
  }

  function onClick(e: React.MouseEvent<HTMLImageElement>) {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * VIEW_W);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * VIEW_H);
    void send({ kind: "click", x, y });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key.length === 1) void send({ kind: "type", text: e.key });
    else void send({ kind: "key", key: e.key });
    e.preventDefault();
  }

  function onWheel(e: React.WheelEvent) {
    void send({ kind: "scroll", dy: Math.round(e.deltaY) });
  }

  async function confirm() {
    setCapturing(true);
    await fetch(`/api/login-sessions/${id}/confirm`, { method: "POST" }).catch(() => undefined);
  }

  const waiting = !(status === "timed_out" || status === "failed") && status !== "awaiting_user";

  return (
    <main>
      <h1>Connect your account</h1>
      <p className="uc-warning">
        Your instance opens the service&apos;s official login page in a browser it controls. We
        capture only your session (encrypted) — never your password.
      </p>

      {status === "timed_out" || status === "failed" ? (
        <div className="uc-card">
          <p>The login session ended ({status}). Start again from the dashboard.</p>
        </div>
      ) : waiting ? (
        <div className="uc-card">
          <p>Opening a secure browser on your instance…</p>
          <p style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>
            The very first time, the instance downloads the CloakBrowser engine (~535 MB),
            which can take a minute or two.
          </p>
        </div>
      ) : embedRelay ? (
        // Headless deployment: no native window, so relay the login page into the dashboard.
        <>
          <div className="uc-card" style={{ marginBottom: 12 }}>
            <p>
              <strong>Sign in below, then capture your session.</strong>
            </p>
            <p style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
              Click once inside the view to give it keyboard focus; scrolling works too. When
              you&apos;ve finished signing in:
            </p>
            <button onClick={confirm} disabled={capturing}>
              {capturing ? "Capturing your session…" : "I've finished logging in — capture my session"}
            </button>
          </div>

          <div
            tabIndex={0}
            onKeyDown={onKeyDown}
            onWheel={onWheel}
            style={{ outline: "none", border: "1px solid var(--uc-border)", borderRadius: "var(--uc-radius)", overflow: "hidden", maxWidth: "100%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={`/api/login-sessions/${id}/frame?t=${frameTick}`}
              alt="login view"
              onClick={onClick}
              style={{ width: "100%", display: "block", cursor: "crosshair" }}
            />
          </div>
        </>
      ) : (
        // Native window (default): the operator logs in in the window that just opened.
        <div className="uc-card">
          <p>
            <strong>A browser window just opened on this machine.</strong>
          </p>
          <ol style={{ color: "var(--uc-text-muted)", fontSize: 15, lineHeight: 1.7, paddingLeft: 20 }}>
            <li>Switch to that window and sign in to the service normally.</li>
            <li>Come back here and click the button below to save your session.</li>
          </ol>
          <button onClick={confirm} disabled={capturing} style={{ marginTop: 4 }}>
            {capturing ? "Capturing your session…" : "I've finished logging in — capture my session"}
          </button>
          <p style={{ color: "var(--uc-text-muted)", fontSize: 13, marginTop: 12 }}>
            Don&apos;t see a window? It may be behind this one — check your taskbar.
          </p>
        </div>
      )}
    </main>
  );
}
