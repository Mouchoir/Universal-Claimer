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
  const [frameTick, setFrameTick] = useState(0);
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
          if (data.status === "connected") {
            router.push("/dashboard");
            return;
          }
        }
      } catch {
        /* ignore */
      }
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

  return (
    <main>
      <h1>Log in to {"the service"}</h1>
      <p className="uc-warning">
        This is the official login page, shown from a browser your own instance controls. Log
        in below; we capture only your session (encrypted), never your password.
      </p>
      <p style={{ color: "var(--uc-text-muted)" }}>Status: {status}</p>

      {status === "timed_out" || status === "failed" ? (
        <div className="uc-card">
          <p>The login session ended ({status}). Start again from the dashboard.</p>
        </div>
      ) : (
        <div
          tabIndex={0}
          onKeyDown={onKeyDown}
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
      )}
      <p style={{ color: "var(--uc-text-muted)", fontSize: 13, marginTop: 8 }}>
        Click and type directly on the view above. Click once inside it first to give it focus
        for keyboard input.
      </p>
    </main>
  );
}
