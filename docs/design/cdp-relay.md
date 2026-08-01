# Design: CDP screencast relay (fluid headless assisted-login)

Supersedes the screenshot-polling relay in [assisted-login.md](./assisted-login.md) for the
**headless deployment** (container on a NAS, wizard accessed from another machine). The
native-window path (local deployment) is unchanged.

## Problem

In a headless deployment the CloakBrowser window opens on the **worker's machine** (the NAS,
under Xvfb). The operator reaches the wizard from a different machine over `https://<nas>:PORT`
and can never see that window, so the login page must be relayed **into the wizard**.

The first relay (screenshot pushed to a `bytea` column, polled by the browser every ~900 ms,
input events round-tripped through a DB table) works but:

- **Laggy**: a full JPEG per poll + a DB write/read on the frame path, and every keystroke is a
  POST → DB insert → worker drain-loop → dispatch round-trip.
- **No copy-paste**: the client only forwarded single-character `keydown`s; a `paste` event was
  never captured, so pasting an email/password/TOTP did nothing.

## Approach

Use Chrome DevTools Protocol **screencast** for push frames and **`Input.insertText`** for real
paste, carried over a **WebSocket** relayed **same-origin** by the web server (so it is `wss://`
on the operator's TLS origin — no mixed-content, no second port to expose on the NAS).

```
operator browser ──wss──▶ web (custom server, ws bridge) ──ws──▶ worker (CDP ⇄ CloakBrowser page)
   frames ◀───────────────────────  bridged by sessionId  ───────────────────────▶ frames
   input  ───────────────────────▶                        ◀─────────────────────── input
```

- **Worker** attaches `context.newCDPSession(page)`, calls `Page.startScreencast`
  (`format: "jpeg"`, capped size/quality), and on each `Page.screencastFrame` forwards the
  base64 frame + metadata, then acks it. Operator input arrives as protocol messages and is
  dispatched via `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`.
- **Web** runs a custom Node server (`apps/web/server.mjs`) that wraps the Next handler and adds
  a `ws` server. Two upgrade paths, paired by `sessionId` in an in-memory bridge:
  - `/api/relay/client/:id` — the operator browser. Authenticated by the admin session cookie
    (same check as the rest of the dashboard); the login session must exist and be
    `awaiting_user`.
  - `/api/relay/worker/:id` — the worker. Authenticated by a shared `RELAY_TOKEN` (both
    services are on the same trusted deployment network; the token guards the internal leg).
  Messages are forwarded verbatim between the two sockets of a pair. Nothing is persisted.
- **Wizard** (relay mode) opens the client socket, paints frames to a `<canvas>`, and sends
  mouse / wheel / key / **paste** events, mapping client pixel coordinates to CloakBrowser
  viewport CSS pixels.

## Protocol

Shared types + the coordinate mapping live in `@uc/core` (`relay.ts`) so web, worker and the
wizard agree, and the mapping is unit-tested. JSON messages:

Worker → client:
- `{ t: "frame", data, format, w, h }` — `data` base64 image; `w`/`h` device px of the frame.
- `{ t: "gone" }` — the browser/page closed.

Client → worker:
- `{ t: "mouse", kind: "move"|"down"|"up"|"click", x, y, button }` — `x`/`y` in **client
  canvas px**; the worker maps them to viewport CSS px using the last frame's `w`/`h`.
- `{ t: "wheel", x, y, dy }`
- `{ t: "key", action: "down"|"up", key, code, text? }` — special keys.
- `{ t: "text", text }` — inserted verbatim via `Input.insertText` (**this is how paste and IME
  work**; the client sends the whole pasted/typed string).

### Keystroke security (unchanged intent)

Keystrokes — including the password — traverse the relay live but are **never persisted**: the
CDP path dispatches them straight to the page, the bridge only forwards in memory, and no input
row is written to the DB anymore. Only the resulting session cookies are stored, encrypted.
This is inherent to any remote-input relay (VNC transmits keystrokes too) and is kept minimal.

## Lifecycle

`runLogin` is unchanged in shape (openSession → `awaiting_user` → wait for the operator's
confirm → capture cookies → `connected` / `timed_out` / `failed`). In relay mode the worker
additionally starts the CDP relay in `openSession` and stops it in `closeSession`. Per-tick
screenshot capture and DB input draining are removed — the relay is event-driven.

## Modes (recap)

- **Native window** (`LOGIN_RELAY_EMBED` unset/false, local deployment): no relay; the operator
  uses the CloakBrowser window directly.
- **CDP relay** (`LOGIN_RELAY_EMBED=true`, headless NAS deployment): the flow above. The worker
  reads the same env to decide whether to start the relay, and connects to the web at
  `RELAY_INTERNAL_URL` (default `ws://127.0.0.1:8080`) with `RELAY_TOKEN`.

## Deployment

The image switches from Next `standalone` to a custom server (`node apps/web/server.mjs`)
so the WebSocket upgrade can be handled in-process; no extra port is published (the relay is
same-origin on the existing web port). `docker-compose.yml` gains `LOGIN_RELAY_EMBED=true` and a
generated `RELAY_TOKEN` on the `app` service.

Web and worker share that container (`deploy/entrypoint.mjs`), so the worker→web leg is a
loopback connection and `RELAY_INTERNAL_URL` only needs setting if the two are split apart again.
`RELAY_TOKEN` still guards it: loopback inside a container is not a trust boundary worth removing
an authentication check for, and it keeps the split deployment working unchanged.
