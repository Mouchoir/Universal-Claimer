import { redirect } from "next/navigation";
import { isAuthenticated } from "@/server/session-cookie";
import { ActivityView } from "./ActivityView";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  if (!isAuthenticated()) redirect("/login");

  return (
    <main>
      {/* The way back lives in the header now, next to the tab for this very page. */}
      <h1>Activity</h1>
      <p style={{ color: "var(--uc-text-muted)", marginTop: -4 }}>
        What ran, when, how it went, and what it actually obtained.
      </p>
      <ActivityView />
    </main>
  );
}
