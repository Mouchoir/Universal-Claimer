import Link from "next/link";
import { redirect } from "next/navigation";
import { isAuthenticated } from "@/server/session-cookie";
import { ActivityView } from "./ActivityView";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  if (!isAuthenticated()) redirect("/login");

  return (
    <main>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1>Activity</h1>
        <Link href="/dashboard" style={{ fontSize: 14 }}>
          ← Dashboard
        </Link>
      </div>
      <p style={{ color: "var(--uc-text-muted)", marginTop: -4 }}>
        What ran, when, how it went, and what it actually obtained.
      </p>
      <ActivityView />
    </main>
  );
}
