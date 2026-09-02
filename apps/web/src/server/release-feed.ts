import { createLogger } from "@uc/core";
import { parseReleases, type Release } from "./updates.js";

/**
 * The published release history, fetched from GitHub and cached.
 *
 * Anonymous GitHub API calls are limited to 60 per hour per IP, and the dashboard polls. Without
 * a cache a single operator refreshing a few times would exhaust the budget.
 *
 * The failure case is the one that bites. Serving a stale list when the fetch fails is right —
 * losing the history entirely would be worse — but doing it *silently* means an instance whose
 * checks have stopped working reports itself as up to date, which is indistinguishable from
 * actually being up to date and is how this instance sat a release behind while insisting
 * otherwise. So a failure is recorded, logged, and reported to the caller.
 */

const REPO = process.env.UPDATE_REPO ?? "Mouchoir/Universal-Claimer";
const TTL_MS = 60 * 60 * 1000;

const log = createLogger({ name: "release-feed" });

interface Cached {
  releases: Release[];
  at: number;
}

let cache: Cached | null = null;
/** Why the last attempt failed, or null when the cache is fresh and trustworthy. */
let lastError: string | null = null;

/** Test seam: drop the cache. */
export function resetReleaseCache(): void {
  cache = null;
  lastError = null;
}

export interface FeedResult {
  releases: Release[];
  /** True when these releases could not be refreshed, so they may be out of date. */
  stale: boolean;
  error?: string;
}

export async function fetchReleases(now: number = Date.now()): Promise<FeedResult> {
  if (cache && now - cache.at < TTL_MS) {
    return { releases: cache.releases, stale: false };
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
      headers: { accept: "application/vnd.github+json" },
      // Next would otherwise cache this itself, on its own schedule, on top of ours.
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`github responded ${res.status}`);
    const releases = parseReleases(await res.json());
    cache = { releases, at: now };
    lastError = null;
    return { releases, stale: false };
  } catch (err) {
    // Offline, rate-limited, DNS, or GitHub down. Keep whatever was last known — but say so.
    lastError = err instanceof Error ? err.message : String(err);
    log.warn("could not refresh the release list", {
      error: lastError,
      servingCached: Boolean(cache),
      cachedAgeMinutes: cache ? Math.round((now - cache.at) / 60000) : null,
    });
    return { releases: cache?.releases ?? [], stale: true, error: lastError };
  }
}

/** The last refresh failure, for callers that want to explain themselves. */
export function lastFeedError(): string | null {
  return lastError;
}
