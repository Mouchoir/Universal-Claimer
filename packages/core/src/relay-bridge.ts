/**
 * Framework-agnostic pairing bridge for the CDP relay (docs/design/cdp-relay.md). Each login
 * session has at most two sockets — the operator's browser (`client`) and the worker
 * (`worker`) — and every message from one is forwarded verbatim to the other. Nothing is
 * persisted. Kept dependency-free (sockets are duck-typed) so it lives in @uc/core, is imported
 * by the plain-JS custom server, and is unit-testable without a real WebSocket.
 */

export type RelayRole = "client" | "worker";

export interface RelaySocket {
  send(data: string): void;
  close(): void;
}

interface Pair {
  client?: RelaySocket;
  worker?: RelaySocket;
}

export class RelayBridge {
  private readonly pairs = new Map<string, Pair>();

  /**
   * Register a socket for a session/role. If a socket for that role already exists (a stale
   * reconnect), the old one is closed and replaced. Returns nothing; call {@link forward} on
   * each incoming message and {@link detach} when the socket closes.
   */
  attach(sessionId: string, role: RelayRole, sock: RelaySocket): void {
    const pair = this.pairs.get(sessionId) ?? {};
    const existing = pair[role];
    pair[role] = sock;
    this.pairs.set(sessionId, pair);
    if (existing && existing !== sock) {
      try {
        existing.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Forward a message from `from` to the opposite side of the pair, if it is connected. */
  forward(sessionId: string, from: RelayRole, data: string): void {
    const pair = this.pairs.get(sessionId);
    if (!pair) return;
    const target = from === "client" ? pair.worker : pair.client;
    if (target) {
      try {
        target.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Detach a socket. The opposite side is closed too — a login can't continue with only one
   * leg — and the pair is dropped once empty.
   */
  detach(sessionId: string, role: RelayRole): void {
    const pair = this.pairs.get(sessionId);
    if (!pair) return;
    delete pair[role];
    const other = role === "client" ? pair.worker : pair.client;
    if (other) {
      try {
        other.close();
      } catch {
        /* ignore */
      }
      delete pair[role === "client" ? "worker" : "client"];
    }
    this.pairs.delete(sessionId);
  }

  /** Number of active (partial or full) session pairs — for tests/diagnostics. */
  size(): number {
    return this.pairs.size;
  }
}
