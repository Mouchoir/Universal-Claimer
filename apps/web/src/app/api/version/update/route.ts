import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { fetchReleases } from "@/server/release-feed";
import { isAuthenticated } from "@/server/session-cookie";
import { computeUpdateState } from "@/server/updates";

export const dynamic = "force-dynamic";

/**
 * Apply the available update.
 *
 * A container cannot recreate itself, so this asks something that can. In the shipped stack that
 * is the `updater` service, whose only job is exactly this; `UPDATE_WEBHOOK_URL` also accepts a
 * Portainer stack webhook for deployments that already have one.
 *
 * The Docker socket stays off this container deliberately. Mounting it here would let the app
 * update itself, and would also mean any flaw in a public-facing Next.js server with a large
 * dependency tree hands over the host's Docker daemon. The updater has no exposed port and one
 * capability, so the same power sits behind far less surface.
 *
 * Method is configurable because the two supported targets disagree: Watchtower's trigger is a
 * GET, a Portainer webhook is a POST. Guessing from the URL would be fragile.
 *
 * No answer from the updater is the outcome, so none is treated as one. Watchtower's trigger
 * normally answers once its run is over — never, when that run replaces this container — but it
 * also answers at once, having done nothing, when another run already holds its lock (the
 * six-hourly poll, say). A Portainer webhook answers on acceptance. So this only starts the
 * update and names the version it should land on; the page watches the running version.
 */
export async function POST(): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  if (!rateLimit("self-update", 5, 10 * 60 * 1000)) {
    return jsonError("RATE_LIMITED", "Too many update attempts. Try again later.", 429);
  }

  const url = process.env.UPDATE_WEBHOOK_URL;
  if (!url) {
    return jsonError(
      "NOT_CONFIGURED",
      "No updater is configured. The shipped stack includes one; set UPDATE_WEBHOOK_URL if you " +
        "removed it or want to point at a Portainer stack webhook instead.",
      400,
    );
  }

  // Checked here, against a fresh release list, rather than trusting the page that asked. A
  // dashboard left open overnight still offered an update the updater had already installed on
  // its own schedule; pressing it ran the updater, which found nothing, and the page said nothing.
  const running = process.env.APP_VERSION ?? "dev";
  const feed = await fetchReleases();
  const { available } = computeUpdateState(running, null, feed.releases);
  if (!feed.stale && available.length === 0) {
    return NextResponse.json({ ok: true, upToDate: true, running });
  }
  // What the page should see running once this has worked; absent when the list is unknown.
  const target = available[0]?.version;

  const token = process.env.UPDATE_TOKEN;
  const method = (process.env.UPDATE_WEBHOOK_METHOD ?? "POST").toUpperCase();

  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      // Watchtower holds the request for its whole run — pulling an image on a NAS takes minutes —
      // and a proxy in front of this app would give up long before that. Past this, the update is
      // under way and the page takes over watching it.
      signal: AbortSignal.timeout(WEBHOOK_WAIT_MS),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) {
      return jsonError("WEBHOOK_FAILED", `The update webhook responded ${res.status}.`, 502);
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    if (!timedOut) return jsonError("WEBHOOK_FAILED", "Could not reach the update webhook.", 502);
  }

  return NextResponse.json({ ok: true, started: true, running, ...(target ? { target } : {}) });
}

/** How long to wait on the updater before answering that the update is under way. */
const WEBHOOK_WAIT_MS = 20_000;
