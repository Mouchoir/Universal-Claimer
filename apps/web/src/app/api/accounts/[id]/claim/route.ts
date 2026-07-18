import { NextResponse } from "next/server";
import {
  CLAIM_QUEUE,
  claimSendOptions,
  createJob,
  getAccount,
  hasActiveJobForAccount,
  hasConsent,
  isConnectorDisabled,
  notifyJobEvent,
} from "@uc/db";
import { getDb, getQueue } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** Trigger a claim on demand (FR-009). Enqueues a job for the worker. */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const { db, pool } = getDb();
  const account = await getAccount(db, params.id);
  if (!account) return jsonError("NOT_FOUND", "Unknown account.", 404);

  if (!(await hasConsent(db, account.serviceId))) {
    return jsonError("CONSENT_REQUIRED", "Consent is required before running a claim.", 403);
  }
  if (await isConnectorDisabled(db, account.serviceId)) {
    return jsonError(
      "CONNECTOR_DISABLED",
      "This connector is temporarily disabled after repeated failures.",
      503,
    );
  }
  if (await hasActiveJobForAccount(db, account.id)) {
    return jsonError("CLAIM_IN_PROGRESS", "A claim is already running for this account.", 409);
  }

  const jobId = await createJob(db, account.id);
  const boss = await getQueue();
  await boss.send(
    CLAIM_QUEUE,
    { jobId, connectedAccountId: account.id, serviceId: account.serviceId },
    claimSendOptions(account.id),
  );
  await notifyJobEvent(pool);

  return NextResponse.json({ jobId, state: "queued" }, { status: 202 });
}
