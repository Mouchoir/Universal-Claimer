import { redirect } from "next/navigation";
import { isSetupNeeded } from "@/server/admin-service";
import { getAdminStore } from "@/server/context";
import { isAuthenticated } from "@/server/session-cookie";

export const dynamic = "force-dynamic";

/** Route based on deployment state: first-run setup → login → dashboard. */
export default async function Home() {
  if (await isSetupNeeded(getAdminStore())) redirect("/setup");
  if (!isAuthenticated()) redirect("/login");
  redirect("/dashboard");
}
