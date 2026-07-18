import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccountByService, hasConsent, isConnectorDisabled, listServices } from "@uc/db";
import { getDb } from "@/server/context";
import { isAuthenticated } from "@/server/session-cookie";
import { ClaimPanel } from "./ClaimPanel";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isAuthenticated()) redirect("/login");

  const { db } = getDb();
  const services = await listServices(db);
  const rows = await Promise.all(
    services.map(async (s) => ({
      ...s,
      connected: (await getAccountByService(db, s.id)) !== null,
      consented: await hasConsent(db, s.id),
      disabled: await isConnectorDisabled(db, s.id),
    })),
  );

  return (
    <main>
      <h1>Dashboard</h1>

      <section style={{ marginTop: 16 }}>
        <h2>Services</h2>
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((s) => (
            <div
              key={s.id}
              className="uc-card"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <div>
                <strong>{s.displayName}</strong>
                <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
                  {s.connected ? "Connected" : "Not connected"}
                  {s.disabled && (
                    <span className="uc-warning"> · connector auto-disabled (repeated failures)</span>
                  )}
                </div>
              </div>
              {s.connected ? (
                <span style={{ color: "var(--uc-success)" }}>✓</span>
              ) : (
                <Link href={`/connect/${s.id}`}>Connect</Link>
              )}
            </div>
          ))}
        </div>
      </section>

      <ClaimPanel />
    </main>
  );
}
