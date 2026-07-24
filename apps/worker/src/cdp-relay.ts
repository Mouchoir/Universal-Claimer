/**
 * Worker side of the CDP screencast relay (docs/design/cdp-relay.md). Attaches a CDP session to
 * the CloakBrowser login page, streams JPEG screencast frames to the web (which bridges them to
 * the operator's wizard over a same-origin WebSocket), and dispatches the operator's input back
 * into the page. Used only in headless deployments (LOGIN_RELAY_EMBED=true); the native-window
 * path never starts a relay.
 */
import WebSocket from "ws";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { parseRelayMsg, type ClientToWorkerMsg, type Logger } from "@uc/core";

export interface CdpRelayConfig {
  /** Base ws:// URL of the web service, e.g. ws://web:8080 (RELAY_INTERNAL_URL). */
  webUrl: string;
  /** Shared secret guarding the internal worker→web leg (RELAY_TOKEN). */
  token: string;
  sessionId: string;
  log: Logger;
}

export interface CdpRelay {
  stop(): Promise<void>;
}

const CDP_MOUSE_BUTTON = { left: "left", middle: "middle", right: "right" } as const;

/**
 * Start relaying `page` over a worker→web WebSocket. Resolves once the socket is open and the
 * screencast has been requested; the relay then runs until {@link CdpRelay.stop} is called or
 * the socket closes. Never throws into the caller's loop — transport errors are logged and the
 * relay simply ends (the operator can still finish in a re-opened session).
 */
export async function startCdpRelay(
  context: BrowserContext,
  page: Page,
  cfg: CdpRelayConfig,
): Promise<CdpRelay> {
  const url = `${cfg.webUrl.replace(/\/$/, "")}/api/relay/worker/${cfg.sessionId}`;
  const ws = new WebSocket(url, { headers: { "x-relay-token": cfg.token } });
  let cdp: CDPSession | null = null;
  let stopped = false;

  const send = (msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const dispatch = async (msg: ClientToWorkerMsg) => {
    if (!cdp) return;
    try {
      switch (msg.t) {
        case "mouse":
          await dispatchMouse(cdp, msg);
          break;
        case "wheel":
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: msg.x,
            y: msg.y,
            deltaX: 0,
            deltaY: msg.dy,
          });
          break;
        case "key":
          await cdp.send("Input.dispatchKeyEvent", {
            type: msg.action === "down" ? "keyDown" : "keyUp",
            key: msg.key,
            code: msg.code,
            text: msg.text,
            // Editing/navigation keys (Backspace, Delete, arrows, Enter) only take effect when
            // the virtual-key code is supplied.
            windowsVirtualKeyCode: msg.vk,
            nativeVirtualKeyCode: msg.vk,
          });
          break;
        case "text":
          // Input.insertText is how paste and IME composition reach the page verbatim.
          await cdp.send("Input.insertText", { text: msg.text });
          break;
      }
    } catch (err) {
      cfg.log.warn("relay input dispatch failed", { err: String(err) });
    }
  };

  ws.on("message", (raw) => {
    const msg = parseRelayMsg(raw.toString());
    // Only client→worker input messages are expected on this leg.
    if (msg && msg.t !== "frame" && msg.t !== "gone") void dispatch(msg as ClientToWorkerMsg);
  });

  await new Promise<void>((resolve) => {
    ws.on("open", () => {
      cfg.log.info("relay socket open", { sid: cfg.sessionId });
      resolve();
    });
    ws.on("error", (err) => {
      cfg.log.warn("relay socket error", { err: String(err) });
      resolve(); // do not block openSession; relay just won't stream
    });
  });

  if (ws.readyState === WebSocket.OPEN) {
    try {
      cdp = await context.newCDPSession(page);
      cdp.on("Page.screencastFrame", async (evt: { data: string; sessionId: number }) => {
        send({ t: "frame", data: evt.data, format: "jpeg", w: 1280, h: 800 });
        try {
          await cdp?.send("Page.screencastFrameAck", { sessionId: evt.sessionId });
        } catch {
          /* page/session gone; ignore */
        }
      });
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });
      cfg.log.info("screencast started", { sid: cfg.sessionId });
    } catch (err) {
      cfg.log.warn("failed to start screencast", { err: String(err) });
    }
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await cdp?.send("Page.stopScreencast");
    } catch {
      /* ignore */
    }
    try {
      await cdp?.detach();
    } catch {
      /* ignore */
    }
    try {
      send({ t: "gone" });
      ws.close();
    } catch {
      /* ignore */
    }
  };

  return { stop };
}

async function dispatchMouse(
  cdp: CDPSession,
  msg: Extract<ClientToWorkerMsg, { t: "mouse" }>,
): Promise<void> {
  const button = CDP_MOUSE_BUTTON[msg.button ?? "left"];
  // Bitmask of buttons currently held (MouseEvent.buttons). Passed through so a press-move-release
  // sequence reads as a drag/selection, not a hover.
  const buttons = msg.buttons ?? 0;
  if (msg.kind === "move") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: msg.x,
      y: msg.y,
      button: buttons ? button : "none",
      buttons,
    });
  } else if (msg.kind === "down") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: msg.x,
      y: msg.y,
      button,
      buttons: buttons || 1,
      clickCount: 1,
    });
  } else if (msg.kind === "up") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: msg.x,
      y: msg.y,
      button,
      buttons: 0,
      clickCount: 1,
    });
  } else {
    // click = press + release at the same point
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: msg.x, y: msg.y, button, buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: msg.x, y: msg.y, button, buttons: 0, clickCount: 1 });
  }
}
