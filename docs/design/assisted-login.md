# Design: Assisted login (auto-capture session cookies)

Goal: guide the operator all the way to a connected account — they click "Log in", complete
the service's real login, and the instance **captures the session cookies automatically** and
stores them encrypted. No manual `cookies.txt` export.

## Why a browser we control (and the trade-off)

The important service session cookies are **HttpOnly** — unreadable by any web page or
bookmarklet (browser security). Only a browser extension or **a browser the instance
controls** can read them. This feature uses the worker's CloakBrowser: the operator logs in
inside it, and the worker reads the resulting cookies from the browser context.

**Security notice shown to the operator** (Principle II / VI): the login happens on the
official service page, inside a browser controlled by *your own self-hosted instance*; the
resulting session cookies are stored **encrypted** so the automation can act as you. Because
the instance controls the browser, only use this on an instance you trust — which, being
self-hosted and single-user, is your own. We never persist your password; only the session.

## Two operating modes

- **Native window** (worker has a screen, e.g. run on the same desktop as the operator): the
  worker opens a headed CloakBrowser window the operator sees and drives directly. No relay.
- **Headless (NAS + Xvfb, the default remote deployment)**: the operator can't see the worker's
  window, so the worker **relays** it into the wizard. This uses the **CDP screencast relay**
  (see [cdp-relay.md](./cdp-relay.md)) — pushed JPEG frames + `Input.insertText`/dispatch over a
  same-origin WebSocket, which is fluid and supports copy-paste. **No VNC** (Principle V): a
  screencast + input relay scoped to one page, not a remote desktop.

  > The original relay (screenshots polled from a `bytea` column + input rows in a `login_input`
  > table) has been **replaced** by the CDP relay; frames and input are now event-driven and
  > never persisted. The sections below describe the original contract for historical context.

## Architecture

New connection method `assisted_login`, alongside `session_import` and `credential_totp`.

1. Operator clicks "Log in & connect" for a service → web creates a **login session** row and
   enqueues a `login` job.
2. Worker `runLogin`: launch CloakBrowser at the connector's `loginUrl`, set status
   `awaiting_user`.
3. Loop (until logged in or timeout): capture a screenshot frame → push to the dashboard;
   drain queued operator input events → apply to the page; check `isLoggedIn`.
4. On success: `extractCookies` from the context → seal → create the `connected_account` →
   status `connected` → close the browser.

## Connector capability

Connectors that support this implement `InteractiveLogin`:

```ts
interface InteractiveLogin {
  readonly loginUrl: string;
  isLoggedIn(session, ctx): Promise<boolean>;
  extractCookies(session): Promise<BrowserCookie[]>;
}
```

Epic implements it: `loginUrl` = Epic login page, `isLoggedIn` reuses the driver's auth check,
`extractCookies` reads `context.cookies()`.

## Relay contract (headless mode)

- **Frames**: worker → dashboard. A PNG per ~800ms, delivered as the login session's current
  frame (served by the web; pushed via SSE notification). Frames are transient and deleted
  when the session ends; they never contain a password field's value in storage (it's just an
  image the operator is looking at live).
- **Inputs**: dashboard → worker. `{kind:"click", x, y}`, `{kind:"type", text}`,
  `{kind:"key", key}`, `{kind:"scroll", dy}`. Coordinates are in viewport space (1280×800,
  matching the worker's browser viewport). Queued in `login_input`, drained + applied by the
  worker.

### Keystroke handling (security)

Relayed keystrokes include the password the operator types on the login page. To avoid
leaving the password in the database in plaintext:
- `drainInputs` **deletes** the input rows as it reads them (not just marks them) — keystrokes
  exist only in the brief enqueue→drain window (~<1s), on the operator's own single-user DB.
- The relayed **frames** never expose the password: the login page renders it as dots.
- The password is never persisted anywhere; only the resulting session cookies are stored,
  encrypted. This is inherent to any remote-input relay (a VNC session would transmit
  keystrokes too), kept minimal here.

## Status lifecycle

```
pending → awaiting_user → connected
                        ↘ timed_out | failed
```

## Delivery

- **Iteration 1**: `InteractiveLogin` capability (Epic) + worker `runLogin` orchestration
  (unit-tested). Works today in local-display mode.
- **Iteration 2**: the frame/input relay channels + API (`/api/login-sessions`) + the
  dashboard login canvas — enables the headless/NAS default.
