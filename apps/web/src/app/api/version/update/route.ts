import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { requireAuth } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Apply the available update.
 *
 * A container cannot recreate itself, so this asks the thing that owns it to. `UPDATE_WEBHOOK_URL`
 * is a Portainer stack webhook: calling it makes Portainer re-pull the image and redeploy.
 *
 * Deliberately not the Docker socket. Mounting it would let the app do this directly, and would
 * also hand any flaw in the app full control of the host's Docker daemon — a large price for
 * saving the operator one paste. A webhook grants exactly one capability: redeploy this stack.
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
      "No update webhook is configured. Set UPDATE_WEBHOOK_URL to a Portainer stack webhook.",
      400,
    );
  }

  try {
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    if (!res.ok) {
      return jsonError("WEBHOOK_FAILED", `The update webhook responded ${res.status}.`, 502);
    }
  } catch {
    return jsonError("WEBHOOK_FAILED", "Could not reach the update webhook.", 502);
  }

  // From here the stack is being redeployed and this container is about to be replaced.
  return NextResponse.json({ ok: true });
}
