import { NextResponse } from "next/server";
import { LAST_SEEN_VERSION, getSetting } from "@uc/db";
import { getDb } from "@/server/context";
import { fetchReleases } from "@/server/release-feed";
import { computeUpdateState } from "@/server/updates";
import { requireAuth } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * What this instance is running, what it could be running, and what changed on the way here.
 *
 * `canUpdate` reports whether an update can be applied from the dashboard at all: a container
 * cannot recreate itself, so applying one means asking Portainer to redeploy the stack through a
 * webhook the operator configured. Without that, the update is real but has to be applied by hand.
 */
export async function GET(): Promise<NextResponse> {
  requireAuth();

  const running = process.env.APP_VERSION ?? "dev";
  const { db } = getDb();
  const [releases, lastSeen] = await Promise.all([
    fetchReleases(),
    getSetting(db, LAST_SEEN_VERSION),
  ]);

  const state = computeUpdateState(running, lastSeen, releases);
  return NextResponse.json({
    ...state,
    canUpdate: Boolean(process.env.UPDATE_WEBHOOK_URL),
  });
}
