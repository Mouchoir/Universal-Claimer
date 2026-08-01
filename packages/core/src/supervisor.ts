/**
 * Process supervisor for the single-image deployment. The web portal and the claim worker are
 * two long-lived Node processes; running them in one container keeps the stack to two services
 * (app + postgres) instead of four, which is what an operator actually wants to look at in a
 * Portainer container list.
 *
 * The cost is that the container needs a PID 1 that behaves, and `sh -c 'a & b & wait'` does not:
 *   - if one process dies the shell keeps waiting on the other, so the container stays "up"
 *     while half the application is gone and the restart policy never fires;
 *   - SIGTERM from `docker stop` goes to the shell, not to the children, so they never get to
 *     close their database pools and Docker kills them after the timeout;
 *   - the container's exit code is the shell's, so nothing upstream can tell what failed.
 *
 * This module is the decision logic only — spawning is injected, so the behaviour above is
 * covered by unit tests rather than by redeploying and watching.
 */

/** A running child process, reduced to what supervision actually needs. */
export interface SupervisedChild {
  /** Name used in logs, e.g. "web". */
  name: string;
  /** Resolves with the exit code once the process terminates. Never rejects. */
  exited: Promise<number>;
  /** Asks the process to terminate. */
  stop: (signal: NodeJS.Signals) => void;
}

export interface SuperviseOptions {
  children: SupervisedChild[];
  /** Registers a handler for the signals Docker sends on `stop`/`restart`. */
  onShutdownSignal: (handler: (signal: NodeJS.Signals) => void) => void;
  /** How long to wait for the remaining children after asking them to stop. Default 10s. */
  graceMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Injected in tests so the grace period does not cost real time. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Runs until the first child exits or a shutdown signal arrives, stops whatever is left, and
 * resolves with the code the container should exit on.
 *
 * A child that exits on its own is always a failure here: both children are daemons that are
 * supposed to run forever, so even a clean `0` means something ended that should not have, and
 * reporting it as success would let a `restart: on-failure` policy leave the container down.
 * A shutdown signal is the opposite case and resolves with `0`.
 */
export async function supervise(opts: SuperviseOptions): Promise<number> {
  const { children, onShutdownSignal } = opts;
  const log = opts.log ?? (() => {});
  const graceMs = opts.graceMs ?? 10_000;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (children.length === 0) throw new Error("supervise: no children to supervise");

  // A second Ctrl-C (or a Docker stop racing a crash) must not restart the shutdown sequence.
  let signalled: NodeJS.Signals | undefined;
  const signalReceived = new Promise<void>((resolve) => {
    onShutdownSignal((signal) => {
      if (signalled) return;
      signalled = signal;
      resolve();
    });
  });

  const firstExit = Promise.race(
    children.map(async (child) => ({ kind: "exit" as const, child, code: await child.exited })),
  );

  const trigger = await Promise.race([
    firstExit,
    signalReceived.then(() => ({ kind: "shutdown" as const })),
  ]);

  let code: number;
  let remaining: SupervisedChild[];
  if (trigger.kind === "exit") {
    log("child exited, taking the container down with it", {
      child: trigger.child.name,
      code: trigger.code,
    });
    code = trigger.code === 0 ? 1 : trigger.code;
    remaining = children.filter((child) => child !== trigger.child);
  } else {
    log("shutdown signal received", { signal: signalled });
    code = 0;
    remaining = children;
  }

  if (remaining.length > 0) {
    // Forward the signal we were given so an operator's SIGINT stays a SIGINT; a crash-triggered
    // shutdown has no originating signal, so ask politely with SIGTERM.
    const stopSignal: NodeJS.Signals = signalled ?? "SIGTERM";
    for (const child of remaining) child.stop(stopSignal);

    let timedOut = true;
    await Promise.race([
      Promise.all(remaining.map((child) => child.exited)).then(() => {
        timedOut = false;
      }),
      wait(graceMs),
    ]);
    // Not an error worth failing on: Docker's own kill timeout is the real backstop, and
    // overriding a genuine child exit code with a grace-period complaint would hide the cause.
    if (timedOut) log("children still running after the grace period", { graceMs });
  }

  return code;
}
