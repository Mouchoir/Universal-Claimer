/**
 * What is running, what is available, and what has changed since the operator last looked.
 *
 * A "version" is one merge to main: the release workflow tags the commit and publishes a release
 * whose body is the patch note, but only after the image has been pushed — so a release existing
 * always means an image exists to install.
 *
 * The releases list is the ordering, not the version strings. Tags are date-and-sha, which sort
 * correctly by luck rather than by design, and nothing here should depend on that: GitHub returns
 * releases newest-first, so position in that list is the authority.
 */

/** One published release, reduced to what the app shows. */
export interface Release {
  version: string;
  notes: string;
  publishedAt: string;
}

export interface UpdateState {
  running: string;
  /** Releases newer than what is running — the update, if any. */
  available: Release[];
  /**
   * Releases at or below what is running that the operator has not been shown yet. This is the
   * "what changed" note, and it appears *after* updating rather than before: you find out what a
   * version did once you are on it.
   */
  unseen: Release[];
}

/** `dev`, or anything not produced by the release workflow, has nothing to compare against. */
export function isReleaseVersion(version: string): boolean {
  return /^v\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/.test(version);
}

/**
 * Split the release history around the running version and the last one the operator saw.
 *
 * `releases` must be newest-first, as the GitHub API returns them.
 */
export function computeUpdateState(
  running: string,
  lastSeen: string | null,
  releases: Release[],
): UpdateState {
  const runningIndex = releases.findIndex((r) => r.version === running);

  // Not a published release, or a release this instance has never heard of: offering an update
  // would mean guessing which direction it is, so offer nothing rather than guess wrong.
  if (runningIndex === -1) return { running, available: [], unseen: [] };

  const available = releases.slice(0, runningIndex);

  const atOrBelow = releases.slice(runningIndex);
  if (lastSeen === null) {
    // First run against a release: showing the entire history as "what's new" would be noise,
    // so treat only the version being run as new.
    return { running, available, unseen: atOrBelow.slice(0, 1) };
  }

  const seenIndex = atOrBelow.findIndex((r) => r.version === lastSeen);
  // An unknown lastSeen means the operator has been away across a history we no longer have, or
  // the value predates a release being deleted. Fall back to just the current version.
  const unseen = seenIndex === -1 ? atOrBelow.slice(0, 1) : atOrBelow.slice(0, seenIndex);

  return { running, available, unseen };
}

/** Shape of the GitHub releases API, narrowed to what we read. */
interface GithubRelease {
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** Parse the GitHub releases payload, dropping anything malformed or not yet published. */
export function parseReleases(payload: unknown): Release[] {
  if (!Array.isArray(payload)) return [];
  const out: Release[] = [];
  for (const item of payload as GithubRelease[]) {
    if (!item || typeof item !== "object") continue;
    if (item.draft === true || item.prerelease === true) continue;
    const version = typeof item.tag_name === "string" ? item.tag_name : null;
    if (!version) continue;
    out.push({
      version,
      notes: typeof item.body === "string" ? item.body.trim() : "",
      publishedAt: typeof item.published_at === "string" ? item.published_at : "",
    });
  }
  return out;
}
