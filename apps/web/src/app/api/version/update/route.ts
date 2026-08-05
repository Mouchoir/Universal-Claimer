import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { requireAuth } from "@/server/session-cookie";

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
 * The response is sent before the redeploy completes, because completing it kills this process.
 */
export async function POST(): Promise<NextResponse> {
  requireAuth();
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

  const token = process.env.UPDATE_TOKEN;
  const method = (process.env.UPDATE_WEBHOOK_METHOD ?? "POST").toUpperCase();

  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) {
      return jsonError("WEBHOOK_FAILED", `The update webhook responded ${res.status}.`, 502);
    }
  } catch {
    return jsonError("WEBHOOK_FAILED", "Could not reach the update webhook.", 502);
  }

  // From here the stack is being redeployed and this container is about to be replaced.
  return NextResponse.json({ ok: true });
}
