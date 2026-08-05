import { parseReleases, type Release } from "./updates.js";

/**
 * The published release history, fetched from GitHub and cached.
 *
 * Anonymous GitHub API calls are limited to 60 per hour per IP, and the dashboard polls. Without
 * a cache a single operator refreshing a few times would exhaust the budget and the update check
 * would start reporting nothing — which looks identical to "you are up to date".
 */

const REPO = process.env.UPDATE_REPO ?? "Mouchoir/Universal-Claimer";
const TTL_MS = 60 * 60 * 1000;

interface Cached {
  releases: Release[];
  at: number;
}

let cache: Cached | null = null;

/** Test seam: drop the cache. */
export function resetReleaseCache(): void {
  cache = null;
}

export async function fetchReleases(now: number = Date.now()): Promise<Release[]> {
  if (cache && now - cache.at < TTL_MS) return cache.releases;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
      headers: { accept: "application/vnd.github+json" },
      // Next would otherwise cache this itself, on its own schedule, on top of ours.
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`github responded ${res.status}`);
    const releases = parseReleases(await res.json());
    cache = { releases, at: now };
    return releases;
  } catch {
    // Offline, rate-limited, or GitHub is down. Serve whatever was last known rather than
    // claiming there are no releases, which would read as "up to date".
    return cache?.releases ?? [];
  }
}
