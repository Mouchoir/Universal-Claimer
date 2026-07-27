import { NextResponse } from "next/server";
import { applyJitter, computeNextRun, nextRunAfterExpiry } from "@uc/core";
import { deleteSchedule, getAccount, getSchedule, upsertSchedule } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { scheduleSchema } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** A day, in ms — used when an expiry-driven schedule has no known end date yet. */
const ONE_DAY_MS = 86_400_000;

/**
 * Next run for an `on_expiry` schedule: when the account's current benefit ends, plus a one-sided
 * random delay. If no end date is known yet (nothing claimed through us so far), check back
 * tomorrow — that run learns the entitlement and the schedule then locks onto its real date.
 */
function expiryRun(account: { facts: { entitlements?: { endsAt?: string }[] } }, jitterMinutes: number): Date {
  const endsAt = account.facts.entitlements?.find((e) => e.endsAt)?.endsAt;
  const parsed = endsAt ? Date.parse(endsAt) : NaN;
  if (!Number.isFinite(parsed)) return new Date(Date.now() + ONE_DAY_MS);
  return nextRunAfterExpiry(new Date(parsed), jitterMinutes);
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const s = await getSchedule(getDb().db, params.id);
  return NextResponse.json({ schedule: s });
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);

  const parsed = scheduleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid schedule", 400);
  }
  const { db } = getDb();
  const account = await getAccount(db, params.id);
  if (!account) {
    return jsonError("NOT_FOUND", "Unknown account.", 404);
  }

  const d = parsed.data;
  // Apply the account's randomization window to the first run too, so even the initial
  // automatic claim doesn't land on an exact, machine-looking time.
  const nextRunAt = d.enabled
    ? d.frequency === "on_expiry"
      ? expiryRun(account, d.jitterMinutes ?? 0)
      : applyJitter(
          computeNextRun(d.frequency, d.hour, d.minute, d.dayOfWeek ?? null, new Date()),
          d.jitterMinutes ?? 0,
        )
    : null;
  await upsertSchedule(db, params.id, {
    frequency: d.frequency,
    hour: d.hour,
    minute: d.minute,
    dayOfWeek: d.dayOfWeek ?? null,
    enabled: d.enabled,
    jitterMinutes: d.jitterMinutes ?? 0,
    nextRunAt,
  });
  return NextResponse.json({ ok: true, nextRunAt });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  await deleteSchedule(getDb().db, params.id);
  return NextResponse.json({ ok: true });
}
