import { describe, expect, it } from "vitest";
import { RelayBridge, type RelaySocket } from "./relay-bridge.js";

function fakeSocket(): RelaySocket & { sent: string[]; closed: boolean } {
  const sent: string[] = [];
  const s = {
    sent,
    closed: false,
    send: (d: string) => void sent.push(d),
    close: () => {
      s.closed = true;
    },
  };
  return s;
}

describe("RelayBridge", () => {
  it("forwards client → worker and worker → client", () => {
    const bridge = new RelayBridge();
    const client = fakeSocket();
    const worker = fakeSocket();
    bridge.attach("s1", "client", client);
    bridge.attach("s1", "worker", worker);

    bridge.forward("s1", "client", '{"t":"text","text":"hi"}');
    bridge.forward("s1", "worker", '{"t":"frame"}');

    expect(worker.sent).toEqual(['{"t":"text","text":"hi"}']);
    expect(client.sent).toEqual(['{"t":"frame"}']);
  });

  it("drops messages when the other side is not connected yet", () => {
    const bridge = new RelayBridge();
    const client = fakeSocket();
    bridge.attach("s1", "client", client);
    // No worker attached; forwarding from client is a no-op (does not throw).
    expect(() => bridge.forward("s1", "client", "x")).not.toThrow();
  });

  it("closes the opposite leg and drops the pair on detach", () => {
    const bridge = new RelayBridge();
    const client = fakeSocket();
    const worker = fakeSocket();
    bridge.attach("s1", "client", client);
    bridge.attach("s1", "worker", worker);

    bridge.detach("s1", "client");
    expect(worker.closed).toBe(true);
    expect(bridge.size()).toBe(0);
  });

  it("replaces and closes a stale socket for the same role", () => {
    const bridge = new RelayBridge();
    const first = fakeSocket();
    const second = fakeSocket();
    bridge.attach("s1", "client", first);
    bridge.attach("s1", "client", second);
    expect(first.closed).toBe(true);

    const worker = fakeSocket();
    bridge.attach("s1", "worker", worker);
    bridge.forward("s1", "worker", "frame");
    // Only the replacement client receives forwarded messages.
    expect(second.sent).toEqual(["frame"]);
    expect(first.sent).toEqual([]);
  });

  it("isolates sessions from each other", () => {
    const bridge = new RelayBridge();
    const c1 = fakeSocket();
    const w1 = fakeSocket();
    const c2 = fakeSocket();
    const w2 = fakeSocket();
    bridge.attach("a", "client", c1);
    bridge.attach("a", "worker", w1);
    bridge.attach("b", "client", c2);
    bridge.attach("b", "worker", w2);

    bridge.forward("a", "client", "for-w1");
    expect(w1.sent).toEqual(["for-w1"]);
    expect(w2.sent).toEqual([]);
  });
});
