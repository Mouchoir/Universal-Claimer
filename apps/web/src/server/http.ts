import { NextResponse } from "next/server";

/** Uniform JSON error envelope used by all API routes. */
export function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
