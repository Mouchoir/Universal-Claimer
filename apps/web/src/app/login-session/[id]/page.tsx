"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

// The worker launches the browser at this fixed viewport (see connectors' defaultFingerprint),
// which is what CDP Input events expect. Mirrors RELAY_VIEWPORT in @uc/core relay.ts — kept
// inline so this client bundle never imports @uc/core (which pulls node crypto).
const VIEW_W = 1280;
const VIEW_H = 800;

type Msg =
  | { t: "frame"; data: string; format: string; w: number; h: number }
  | { t: "gone" };

// Editing / navigation keys → Windows virtual-key codes. CDP needs the vk for these to take
// effect; printable characters and paste go through insertText instead (see onBeforeInput).
const KEY_VK: Record<string, number> = {
  Backspace: 8, Delete: 46, Enter: 13, Tab: 9, Escape: 27,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

/** Map a pointer position on the canvas to CloakBrowser viewport CSS px (see @uc/core). */
function mapPointer(clientX: number, clientY: number, dispW: number, dispH: number) {
  if (dispW <= 0 || dispH <= 0) return { x: 0, y: 0 };
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  return {
    x: clamp(Math.round((clientX / dispW) * VIEW_W), VIEW_W - 1),
    y: clamp(Math.round((clientY / dispH) * VIEW_H), VIEW_H - 1),
  };
}

export default function LoginSessionPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<string>("pending");
  const [embedRelay, setEmbedRelay] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Poll status (drives the redirect on success and reveals the deployment mode).
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
          if (data.status === "connected") router.push("/dashboard");
        }
      } catch {
        /* ignore */
      }
    };
    const iv = setInterval(tick, 1200);
    void tick();
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id, router]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendKey = useCallback(
    (key: string, code: string, vk: number | undefined) => {
      send({ t: "key", action: "down", key, code, vk });
      send({ t: "key", action: "up", key, code, vk });
    },
    [send],
  );

  // Open the relay WebSocket once we are awaiting login in relay mode.
  useEffect(() => {
    if (!embedRelay || status !== "awaiting_user" || wsRef.current) return;
    let closed = false;
    (async () => {
      try {
        const res = await fetch(`/api/login-sessions/${id}/relay-ticket`, { method: "POST" });
        if (!res.ok) throw new Error("ticket request failed");
        const { ticket } = await res.json();
        if (closed) return;
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${proto}//${window.location.host}/api/relay/client/${id}?ticket=${encodeURIComponent(ticket)}`,
        );
        wsRef.current = ws;
        if (!imgRef.current) imgRef.current = new Image();
        ws.onmessage = (ev) => {
          let msg: Msg;
          try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          } catch {
            return;
          }
          if (msg.t === "frame") drawFrame(msg);
          else if (msg.t === "gone") setRelayError("The login browser closed. Start again.");
        };
        ws.onerror = () => setRelayError("Live view connection error.");
      } catch {
        setRelayError("Could not open the live view.");
      }
    })();
    return () => {
      closed = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [embedRelay, status, id]);

  // Keyboard + paste are captured on a hidden, focused textarea: a <canvas> is not editable, so
  // it never receives paste/beforeinput events. Native listeners are the most reliable path.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || !embedRelay || status !== "awaiting_user") return;
    ta.focus();

    const onKey = (e: KeyboardEvent) => {
      // Editing/navigation keys. Ctrl/Cmd combos flow through to the paste handler.
      if (e.key in KEY_VK && !e.ctrlKey && !e.metaKey) {
        sendKey(e.key, e.code || e.key, KEY_VK[e.key]);
        e.preventDefault();
      }
    };
    const onBefore = (e: InputEvent) => {
      const it = e.inputType;
      if (
        it === "insertText" ||
        it === "insertReplacementText" ||
        it === "insertCompositionText"
      ) {
        if (e.data) send({ t: "text", text: e.data });
        e.preventDefault();
      }
      // Deletion is handled via keydown (Backspace/Delete) so it works on the empty textarea;
      // paste is handled by the paste listener below.
    };
    const onPasteEv = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text");
      if (text) send({ t: "text", text });
      e.preventDefault();
    };

    ta.addEventListener("keydown", onKey);
    ta.addEventListener("beforeinput", onBefore);
    ta.addEventListener("paste", onPasteEv);
    return () => {
      ta.removeEventListener("keydown", onKey);
      ta.removeEventListener("beforeinput", onBefore);
      ta.removeEventListener("paste", onPasteEv);
    };
  }, [embedRelay, status, send, sendKey]);

  function drawFrame(msg: { data: string; format: string; w: number; h: number }) {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    img.onload = () => {
      if (canvas.width !== msg.w) canvas.width = msg.w;
      if (canvas.height !== msg.h) canvas.height = msg.h;
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = `data:image/${msg.format};base64,${msg.data}`;
  }

  function pointer(e: React.MouseEvent) {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    return mapPointer(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
  }
  const button = (e: React.MouseEvent) => (e.button === 2 ? "right" : e.button === 1 ? "middle" : "left");

  const onMouseDown = (e: React.MouseEvent) => {
    // Prevent the default focus change (the canvas isn't focusable, so the browser would blur
    // our capture textarea and keystrokes would go nowhere), then route the keyboard to it.
    e.preventDefault();
    taRef.current?.focus();
    send({ t: "mouse", kind: "down", ...pointer(e), button: button(e), buttons: e.buttons });
  };
  const onMouseUp = (e: React.MouseEvent) =>
    send({ t: "mouse", kind: "up", ...pointer(e), button: button(e), buttons: e.buttons });
  const onMouseMove = (e: React.MouseEvent) => {
    if (e.buttons) send({ t: "mouse", kind: "move", ...pointer(e), buttons: e.buttons });
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = pointer(e as unknown as React.MouseEvent);
    send({ t: "wheel", x: p.x, y: p.y, dy: Math.round(e.deltaY) });
  };

  async function confirm() {
    setCapturing(true);
    await fetch(`/api/login-sessions/${id}/confirm`, { method: "POST" }).catch(() => undefined);
  }

  const waiting = !(status === "timed_out" || status === "failed") && status !== "awaiting_user";
  const captureButton = (
    <button onClick={confirm} disabled={capturing} style={{ marginTop: 4 }}>
      {capturing ? "Capturing your session…" : "I've finished logging in — capture my session"}
    </button>
  );

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
        // Headless deployment: the login page is streamed here; sign in right in this view.
        <>
          <div className="uc-card" style={{ marginBottom: 12 }}>
            <p>
              <strong>Sign in in the live view below, then capture your session.</strong>
            </p>
            <p style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
              Click inside the view to focus it. Typing, editing, text selection and paste
              (Ctrl/Cmd+V) all work. When you&apos;ve finished signing in:
            </p>
            {captureButton}
            {relayError && (
              <p style={{ color: "var(--uc-danger, #f87171)", fontSize: 13, marginTop: 8 }}>{relayError}</p>
            )}
          </div>

          {/* Hidden capture surface for keyboard + paste (canvas can't receive those). */}
          <textarea
            ref={taRef}
            aria-hidden="true"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ position: "fixed", top: 0, left: 0, width: 1, height: 1, opacity: 0, pointerEvents: "none", zIndex: -1 }}
          />
          <canvas
            ref={canvasRef}
            width={VIEW_W}
            height={VIEW_H}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onMouseMove={onMouseMove}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              width: "100%",
              display: "block",
              cursor: "text",
              border: "1px solid var(--uc-border)",
              borderRadius: "var(--uc-radius)",
              background: "#000",
            }}
          />
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
          {captureButton}
          <p style={{ color: "var(--uc-text-muted)", fontSize: 13, marginTop: 12 }}>
            Don&apos;t see a window? It may be behind this one — check your taskbar.
          </p>
        </div>
      )}
    </main>
  );
}
