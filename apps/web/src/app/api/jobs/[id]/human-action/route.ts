import { NextResponse } from "next/server";
import {
  CLAIM_QUEUE,
  claimSendOptions,
  getJob,
  markRunning,
  notifyJobEvent,
} from "@uc/db";
import { getDb, getQueue } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Operator signals a human-action challenge is resolved (Story 4 / FR-014). Resumes the
 * paused job by re-enqueuing it (the claim is idempotent — nothing_to_claim if already
 * done), rather than restarting from scratch. No VNC involved: the operator completes the
 * challenge in their own browser.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const { db, pool } = getDb();
  const job = await getJob(db, params.id);
  if (!job) return jsonError("NOT_FOUND", "Unknown job.", 404);
  if (job.state !== "requires_human_action") {
    return jsonError("NOT_WAITING", "This job is not awaiting human action.", 409);
  }

  await markRunning(db, job.id);
  const boss = await getQueue();
  await boss.send(
    CLAIM_QUEUE,
    { jobId: job.id, connectedAccountId: job.connectedAccountId, serviceId: job.serviceId },
    claimSendOptions(job.connectedAccountId),
  );
  await notifyJobEvent(pool);

  return NextResponse.json({ state: "running" });
}
