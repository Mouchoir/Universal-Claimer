import { describe, expect, it, vi } from "vitest";
import { supervise, type SupervisedChild } from "./supervisor.js";

/** A child whose exit is driven by the test. */
function fakeChild(name: string) {
  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const stop = vi.fn<(signal: NodeJS.Signals) => void>();
  const child: SupervisedChild = { name, exited, stop };
  return { child, stop, exit: (code: number) => settle(code) };
}

/** Captures the registered signal handler so a test can fire it. */
function signalHook() {
  let handler: ((signal: NodeJS.Signals) => void) | undefined;
  return {
    onShutdownSignal: (h: (signal: NodeJS.Signals) => void) => {
      handler = h;
    },
    fire: (signal: NodeJS.Signals) => handler?.(signal),
  };
}

const noWait = () => Promise.resolve();

describe("supervise", () => {
  it("stops the other children when one exits", async () => {
    const web = fakeChild("web");
    const worker = fakeChild("worker");
    const signals = signalHook();

    const result = supervise({
      children: [web.child, worker.child],
      onShutdownSignal: signals.onShutdownSignal,
      wait: noWait,
    });

    web.exit(3);
    await vi.waitFor(() => expect(worker.stop).toHaveBeenCalledWith("SIGTERM"));
    worker.exit(0);

    expect(await result).toBe(3);
    // The child that already exited is never signalled.
    expect(web.stop).not.toHaveBeenCalled();
  });

  it("treats a child exiting with 0 as a failure", async () => {
    // Both children are daemons: a clean exit still means the container lost half its function,
    // and returning 0 would let `restart: on-failure` leave it down.
    const web = fakeChild("web");
    const worker = fakeChild("worker");
    const signals = signalHook();

    const result = supervise({
      children: [web.child, worker.child],
      onShutdownSignal: signals.onShutdownSignal,
      wait: noWait,
    });

    worker.exit(0);
    await vi.waitFor(() => expect(web.stop).toHaveBeenCalled());
    web.exit(0);

    expect(await result).toBe(1);
  });

  it("forwards a shutdown signal to every child and exits 0", async () => {
    const web = fakeChild("web");
    const worker = fakeChild("worker");
    const signals = signalHook();

    const result = supervise({
      children: [web.child, worker.child],
      onShutdownSignal: signals.onShutdownSignal,
      wait: noWait,
    });

    signals.fire("SIGTERM");
    await vi.waitFor(() => {
      expect(web.stop).toHaveBeenCalledWith("SIGTERM");
      expect(worker.stop).toHaveBeenCalledWith("SIGTERM");
    });
    web.exit(0);
    worker.exit(0);

    expect(await result).toBe(0);
  });

  it("forwards the signal it was given rather than always SIGTERM", async () => {
    const web = fakeChild("web");
    const signals = signalHook();

    const result = supervise({
      children: [web.child],
      onShutdownSignal: signals.onShutdownSignal,
      wait: noWait,
    });

    signals.fire("SIGINT");
    await vi.waitFor(() => expect(web.stop).toHaveBeenCalledWith("SIGINT"));
    web.exit(0);

    expect(await result).toBe(0);
  });

  it("ignores a repeated signal so the shutdown is not restarted", async () => {
    const web = fakeChild("web");
    const signals = signalHook();

    const result = supervise({
      children: [web.child],
      onShutdownSignal: signals.onShutdownSignal,
      wait: noWait,
    });

    signals.fire("SIGTERM");
    signals.fire("SIGTERM");
    signals.fire("SIGINT");
    await vi.waitFor(() => expect(web.stop).toHaveBeenCalledTimes(1));
    web.exit(0);

    expect(await result).toBe(0);
  });

  it("gives up on a child that outlives the grace period, keeping the original exit code", async () => {
    const web = fakeChild("web");
    const worker = fakeChild("worker"); // never exits
    const signals = signalHook();
    const log = vi.fn();

    const result = supervise({
      children: [web.child, worker.child],
      onShutdownSignal: signals.onShutdownSignal,
      graceMs: 5,
      wait: noWait,
      log,
    });

    web.exit(2);

    expect(await result).toBe(2);
    expect(log).toHaveBeenCalledWith("children still running after the grace period", {
      graceMs: 5,
    });
  });

  it("rejects an empty child list", async () => {
    await expect(
      supervise({ children: [], onShutdownSignal: () => {} }),
    ).rejects.toThrow(/no children/);
  });
});
