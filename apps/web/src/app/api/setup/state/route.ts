import { NextResponse } from "next/server";
import { getAdminStore } from "@/server/context";
import { isSetupNeeded } from "@/server/admin-service";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const needsSetup = await isSetupNeeded(getAdminStore());
  return NextResponse.json({ needsSetup });
}
