"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useExpandable } from "@/components/use-expandable";

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
  // Name the service in the heading rather than saying "your account": with several services
  // connected, a generic title leaves you guessing which login this window is for.
  const [serviceId, setServiceId] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // preventScroll matters: the capture textarea sits inside the stage rather than pinned to the
  // viewport (native fullscreen only renders the stage's subtree), so a plain focus() can scroll
  // the page to reach it — shifting the canvas out from under the click being processed.
  const focusCapture = useCallback(() => taRef.current?.focus({ preventScroll: true }), []);

  // Entering or leaving fullscreen moves focus, and keystrokes go nowhere the moment the hidden
  // capture textarea loses it. Every transition puts it back.
  const refocus = useCallback(() => {
    // After the transition frame: the browser is still rearranging focus during the event.
    requestAnimationFrame(() => focusCapture());
  }, [focusCapture]);
  const stage = useExpandable(stageRef, refocus);
  const { escapeExits, collapse: collapseStage } = stage;

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
          if (data.serviceId) setServiceId(data.serviceId);
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
    (key: string, code: string, vk: number | undefined, modifiers = 0) => {
      send({ t: "key", action: "down", key, code, vk, modifiers });
      send({ t: "key", action: "up", key, code, vk, modifiers });
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
    focusCapture();

    const onKey = (e: KeyboardEvent) => {
      // Escape is a real key the remote login page may want, so it is normally forwarded. The
      // one exception is the CSS fallback for fullscreen: nothing is intercepting Escape on our
      // behalf there, so it has to close the expanded view instead. Under the browser's own
      // fullscreen this never fires — the Escape that exits is consumed before reaching us.
      if (e.key === "Escape" && escapeExits) {
        collapseStage();
        e.preventDefault();
        return;
      }
      const ctrlish = e.ctrlKey || e.metaKey;
      // Ctrl/Cmd+V is handled by the paste listener (local clipboard → insertText).
      if (ctrlish && (e.key === "v" || e.key === "V")) return;

      const modifiers =
        (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

      // Editing/navigation keys — forwarded with modifiers so Shift+Arrow extends the
      // selection and Ctrl+Arrow jumps by word.
      if (e.key in KEY_VK) {
        sendKey(e.key, e.code || e.key, KEY_VK[e.key], modifiers);
        e.preventDefault();
        return;
      }
      // Ctrl/Cmd shortcuts on a letter (select-all, copy, cut, undo/redo) — forwarded so the
      // remote page performs them. Printable typing (no ctrl/meta) is left to beforeinput.
      if (ctrlish && e.key.length === 1) {
        const upper = e.key.toUpperCase();
        sendKey(e.key, e.code || `Key${upper}`, upper.charCodeAt(0), modifiers);
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
    // Depends on the two values it actually reads, not on the whole `stage` object: that object
    // is rebuilt every render, which would tear down and re-register these listeners — and
    // re-assert focus — on every single render.
  }, [embedRelay, status, send, sendKey, focusCapture, escapeExits, collapseStage]);

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
    // Read the position BEFORE touching focus. pointer() measures the canvas with
    // getBoundingClientRect, while e.clientX/Y were captured when the event fired: anything that
    // moves the canvas in between makes the two disagree and the click lands somewhere else in
    // the remote page — which looks like the page ignoring you, not like a mis-aimed click.
    const at = pointer(e);
    // Prevent the default focus change (the canvas isn't focusable, so the browser would blur
    // our capture textarea and keystrokes would go nowhere), then route the keyboard to it.
    e.preventDefault();
    focusCapture();
    send({ t: "mouse", kind: "down", ...at, button: button(e), buttons: e.buttons });
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
      <h1>{serviceId ? `Connect your ${serviceId} account` : "Connect your account"}</h1>
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
            {/* On success the worker closes the browser (sends "gone"); don't flash that as an
                error while we're capturing. */}
            {relayError && !capturing && (
              <p style={{ color: "var(--uc-danger, #f87171)", fontSize: 13, marginTop: 8 }}>{relayError}</p>
            )}
          </div>

          {/* Everything the operator needs while the view fills the screen lives in here: native
              fullscreen renders only this subtree, so anything left outside becomes unreachable
              — including the capture textarea, which would silently stop receiving keystrokes. */}
          <div
            ref={stageRef}
            className={stage.expanded && !stage.nativeFullscreen ? "uc-stage uc-stage-expanded" : "uc-stage"}
          >
            <div className="uc-stage-bar">
              <button type="button" className="uc-quiet" onClick={stage.toggle}>
                {stage.expanded ? "Exit fullscreen" : "Fullscreen"}
              </button>
              {stage.expanded && (
                <>
                  {/* True either way: the browser's own fullscreen consumes Escape to exit, and
                      the CSS fallback binds it in the key handler. */}
                  <span style={{ color: "var(--uc-text-muted)", fontSize: 13 }}>
                    Press Esc to exit.
                  </span>
                  {captureButton}
                </>
              )}
            </div>

            {/* Hidden capture surface for keyboard + paste (canvas can't receive those). */}
            <textarea
              ref={taRef}
              aria-hidden="true"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            />
            <div className="uc-stage-view">
              <canvas
                ref={canvasRef}
                width={VIEW_W}
                height={VIEW_H}
                onMouseDown={onMouseDown}
                onMouseUp={onMouseUp}
                onMouseMove={onMouseMove}
                onWheel={onWheel}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>
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
          {captureButton}
          <p style={{ color: "var(--uc-text-muted)", fontSize: 13, marginTop: 12 }}>
            Don&apos;t see a window? It may be behind this one — check your taskbar.
          </p>
        </div>
      )}
    </main>
  );
}
