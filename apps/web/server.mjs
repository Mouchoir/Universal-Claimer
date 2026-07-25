/**
 * Custom Next.js server that adds the CDP relay WebSocket (docs/design/cdp-relay.md). Next
 * route handlers can't accept a WebSocket upgrade, so the relay is bridged here, in-process and
 * same-origin (no extra port to publish on the NAS). Everything else is delegated to Next.
 *
 * Two upgrade paths, paired by session id in an in-memory bridge:
 *   /api/relay/client/:id  — operator browser, authorized by a short-lived relay ticket.
 *   /api/relay/worker/:id  — worker, authorized by the shared RELAY_TOKEN.
 */
import { createServer } from "node:http";
import { parse } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import { RelayBridge, constantTimeEqual, verifyRelayTicket } from "@uc/core";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3005);
// Resolve the Next app dir from this file so the server works regardless of cwd (Docker runs it
// from the repo root: `node apps/web/server.mjs`).
const dir = dirname(fileURLToPath(import.meta.url));

const app = next({ dev, hostname, port, dir });
const handle = app.getRequestHandler();

const RELAY_RE = /^\/api\/relay\/(client|worker)\/([0-9a-fA-F-]{36})$/;

await app.prepare();

const server = createServer((req, res) => {
  handle(req, res, parse(req.url ?? "/", true));
});

const bridge = new RelayBridge();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = parse(req.url ?? "/", true);
  const m = pathname && RELAY_RE.exec(pathname);
  if (!m) {
    socket.destroy();
    return;
  }
  const role = m[1]; // "client" | "worker"
  const sessionId = m[2];

  // Authorize before completing the upgrade.
  if (role === "client") {
    const key = process.env.APP_ENCRYPTION_KEY ?? "";
    const ticket = typeof query.ticket === "string" ? query.ticket : undefined;
    if (!verifyRelayTicket(key, ticket, sessionId)) {
      socket.destroy();
      return;
    }
  } else {
    const expected = process.env.RELAY_TOKEN ?? "";
    const got = req.headers["x-relay-token"];
    if (!expected || typeof got !== "string" || !constantTimeEqual(got, expected)) {
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    bridge.attach(sessionId, role, ws);
    ws.on("message", (data) => bridge.forward(sessionId, role, data.toString()));
    ws.on("close", () => bridge.detach(sessionId, role));
    ws.on("error", () => bridge.detach(sessionId, role));
  });
});

server.listen(port, hostname, () => {
  // eslint-disable-next-line no-console
  console.log(`web listening on http://${hostname}:${port} (relay ws enabled)`);
});
