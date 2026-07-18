import { NextResponse } from "next/server";
import { endSession } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  endSession();
  return NextResponse.json({ ok: true });
}
