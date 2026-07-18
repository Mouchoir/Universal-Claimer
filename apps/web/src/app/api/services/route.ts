import { NextResponse } from "next/server";
import { getAccountByService, hasConsent, listServices } from "@uc/db";
import { getDb } from "@/server/context";
import { jsonError } from "@/server/http";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!isAuthenticated()) return jsonError("UNAUTHENTICATED", "Sign in required.", 401);
  const { db } = getDb();
  const services = await listServices(db);
  const rows = await Promise.all(
    services.map(async (s) => ({
      id: s.id,
      displayName: s.displayName,
      methods: s.methods,
      connected: (await getAccountByService(db, s.id)) !== null,
      consented: await hasConsent(db, s.id),
    })),
  );
  return NextResponse.json({ services: rows });
}
