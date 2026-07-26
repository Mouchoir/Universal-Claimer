export type Frequency = "daily" | "weekly";

/**
 * Compute the next run time for a schedule, in the host's local timezone, strictly after
 * `now`. Deterministic (no jitter) so it can be displayed and tested. Minute granularity.
 * Shared by the web app (initial next-run when saving) and the worker (advancing).
 */
export function computeNextRun(
  frequency: Frequency,
  hour: number,
  minute: number,
  dayOfWeek: number | null | undefined,
  now: Date,
): Date {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (frequency === "daily") {
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  // weekly
  const target = (((dayOfWeek ?? 0) % 7) + 7) % 7;
  let deltaDays = (target - next.getDay() + 7) % 7;
  if (deltaDays === 0 && next.getTime() <= now.getTime()) deltaDays = 7;
  next.setDate(next.getDate() + deltaDays);
  return next;
}

/**
 * A small random delay (seconds) applied to each automatic enqueue so multiple accounts do
 * not run at the exact same instant (Constitution Principle VII). Injectable RNG for tests.
 */
export function jitterSeconds(maxSeconds = 45, rand: () => number = Math.random): number {
  return Math.floor(rand() * (maxSeconds + 1));
}

/**
 * Shift a scheduled run by a random offset within ±`jitterMinutes`, so automatic claims don't
 * land on a machine-perfect time every day — an obvious automation signal to the services
 * (Constitution Principle VII). Whole-minute resolution; 0 or less returns the time unchanged.
 * Injectable RNG for deterministic tests.
 */
export function applyJitter(
  runAt: Date,
  jitterMinutes: number,
  rand: () => number = Math.random,
): Date {
  if (!Number.isFinite(jitterMinutes) || jitterMinutes <= 0) return runAt;
  // rand() in [0,1) → offset in [-jitter, +jitter] minutes.
  const offset = Math.round((rand() * 2 - 1) * jitterMinutes);
  return new Date(runAt.getTime() + offset * 60_000);
}
