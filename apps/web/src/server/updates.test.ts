import { describe, expect, it } from "vitest";
import { computeUpdateState, isReleaseVersion, parseReleases, type Release } from "./updates.js";

/** Newest first, as the GitHub API returns them. */
const rel = (version: string, notes = `notes for ${version}`): Release => ({
  version,
  notes,
  publishedAt: "2026-08-01T00:00:00Z",
});

const HISTORY = [
  rel("v2026.08.04-dddddd4"),
  rel("v2026.08.03-cccccc3"),
  rel("v2026.08.02-bbbbbb2"),
  rel("v2026.08.01-aaaaaa1"),
];

describe("isReleaseVersion", () => {
  it("accepts what the release workflow produces", () => {
    expect(isReleaseVersion("v2026.08.04-dddddd4")).toBe(true);
  });

  it("rejects a local build", () => {
    expect(isReleaseVersion("dev")).toBe(false);
    expect(isReleaseVersion("")).toBe(false);
    expect(isReleaseVersion("v1.2.3")).toBe(false);
  });
});

describe("computeUpdateState", () => {
  it("reports every newer release as available", () => {
    const s = computeUpdateState("v2026.08.02-bbbbbb2", "v2026.08.02-bbbbbb2", HISTORY);
    expect(s.available.map((r) => r.version)).toEqual([
      "v2026.08.04-dddddd4",
      "v2026.08.03-cccccc3",
    ]);
  });

  it("reports nothing available when running the newest", () => {
    const s = computeUpdateState("v2026.08.04-dddddd4", "v2026.08.04-dddddd4", HISTORY);
    expect(s.available).toEqual([]);
    expect(s.unseen).toEqual([]);
  });

  it("collects the notes for every version crossed by an update", () => {
    // Was on .01 and saw it; now running .03. Two versions' notes are owed, not one.
    const s = computeUpdateState("v2026.08.03-cccccc3", "v2026.08.01-aaaaaa1", HISTORY);
    expect(s.unseen.map((r) => r.version)).toEqual([
      "v2026.08.03-cccccc3",
      "v2026.08.02-bbbbbb2",
    ]);
  });

  it("owes nothing once the running version has been seen", () => {
    const s = computeUpdateState("v2026.08.03-cccccc3", "v2026.08.03-cccccc3", HISTORY);
    expect(s.unseen).toEqual([]);
  });

  it("never treats a newer release as a note owed", () => {
    // .04 exists but is not installed; its notes belong to the update, not to this instance.
    const s = computeUpdateState("v2026.08.03-cccccc3", "v2026.08.02-bbbbbb2", HISTORY);
    expect(s.unseen.map((r) => r.version)).toEqual(["v2026.08.03-cccccc3"]);
  });

  it("shows only the current version on a first run, not the whole history", () => {
    const s = computeUpdateState("v2026.08.03-cccccc3", null, HISTORY);
    expect(s.unseen.map((r) => r.version)).toEqual(["v2026.08.03-cccccc3"]);
  });

  it("falls back to the current version when the last seen one is gone", () => {
    const s = computeUpdateState("v2026.08.03-cccccc3", "v2025.01.01-0000000", HISTORY);
    expect(s.unseen.map((r) => r.version)).toEqual(["v2026.08.03-cccccc3"]);
  });

  it("offers nothing for a build that is not in the release list", () => {
    // A local or hand-built image: which direction an "update" would go is unknowable, so the
    // honest answer is silence rather than a guess.
    const s = computeUpdateState("dev", null, HISTORY);
    expect(s).toEqual({ running: "dev", available: [], unseen: [] });
  });

  it("offers nothing when there are no releases at all", () => {
    const s = computeUpdateState("v2026.08.04-dddddd4", null, []);
    expect(s.available).toEqual([]);
    expect(s.unseen).toEqual([]);
  });
});

describe("parseReleases", () => {
  it("maps the fields it needs", () => {
    const parsed = parseReleases([
      { tag_name: "v2026.08.04-dddddd4", body: "  Fixed a thing.  ", published_at: "2026-08-04T10:00:00Z" },
    ]);
    expect(parsed).toEqual([
      { version: "v2026.08.04-dddddd4", notes: "Fixed a thing.", publishedAt: "2026-08-04T10:00:00Z" },
    ]);
  });

  it("skips drafts and prereleases, which have no image published", () => {
    const parsed = parseReleases([
      { tag_name: "v2026.08.05-eeeeee5", draft: true },
      { tag_name: "v2026.08.04-dddddd4", prerelease: true },
      { tag_name: "v2026.08.03-cccccc3" },
    ]);
    expect(parsed.map((r) => r.version)).toEqual(["v2026.08.03-cccccc3"]);
  });

  it("tolerates a malformed payload rather than breaking the dashboard", () => {
    expect(parseReleases(null)).toEqual([]);
    expect(parseReleases({ message: "rate limited" })).toEqual([]);
    expect(parseReleases([null, 42, { body: "no tag" }])).toEqual([]);
  });
});
