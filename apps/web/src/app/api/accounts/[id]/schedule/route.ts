import { NextResponse } from "next/server";
import { computeNextRun } from "@uc/core";
import { deleteSchedule, getAccount, getSchedule, upsertSchedule } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { scheduleSchema } from "@/server/schemas";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

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
  if (!(await getAccount(db, params.id))) {
    return jsonError("NOT_FOUND", "Unknown account.", 404);
  }

  const d = parsed.data;
  const nextRunAt = d.enabled
    ? computeNextRun(d.frequency, d.hour, d.minute, d.dayOfWeek ?? null, new Date())
    : null;
  await upsertSchedule(db, params.id, {
    frequency: d.frequency,
    hour: d.hour,
    minute: d.minute,
    dayOfWeek: d.dayOfWeek ?? null,
    enabled: d.enabled,
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
