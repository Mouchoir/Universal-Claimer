import { NextResponse } from "next/server";
import { sealSecret } from "@uc/core";
import { upsertNotificationTarget } from "@uc/db";
import { isSetupNeeded, setupAdmin, SetupAlreadyDoneError } from "@/server/admin-service";
import { getAdminStore, getDb, getMasterKey } from "@/server/context";
import { jsonError } from "@/server/http";
import { setupSchema } from "@/server/schemas";
import { startSession } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const store = getAdminStore();
  if (!(await isSetupNeeded(store))) {
    return jsonError("SETUP_ALREADY_DONE", "Setup has already been completed.", 409);
  }

  const parsed = setupSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input", 400);
  }

  try {
    await setupAdmin(store, {
      password: parsed.data.password,
      recovery: parsed.data.recovery,
    });
  } catch (err) {
    if (err instanceof SetupAlreadyDoneError) {
      return jsonError("SETUP_ALREADY_DONE", "Setup has already been completed.", 409);
    }
    throw err;
  }

  if (parsed.data.webhook) {
    const sealed = sealSecret(JSON.stringify({ url: parsed.data.webhook.url }), getMasterKey());
    await upsertNotificationTarget(getDb().db, {
      kind: parsed.data.webhook.kind,
      configCiphertext: sealed.ciphertext,
      configDataKey: sealed.wrappedDataKey,
    });
  }

  startSession(req);
  return NextResponse.json({ ok: true }, { status: 201 });
}
