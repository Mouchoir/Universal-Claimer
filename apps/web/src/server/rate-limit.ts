/**
 * Minimal in-memory fixed-window rate limiter. Single-user deployment, so a per-key global
 * counter is sufficient to blunt brute-force attempts on login/recovery without extra infra.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Returns true if the action is allowed, false if the limit is exceeded. */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

/** Test helper: clear all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
