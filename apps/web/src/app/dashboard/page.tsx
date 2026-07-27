import Link from "next/link";
import { redirect } from "next/navigation";
import { connectorDisabledReason, getAccountByService, hasConsent, listServices } from "@uc/db";
import { getDb } from "@/server/context";
import { isAuthenticated } from "@/server/session-cookie";
import { ClaimPanel } from "./ClaimPanel";
import { EnableConnector } from "./EnableConnector";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isAuthenticated()) redirect("/login");

  const { db } = getDb();
  const services = await listServices(db);
  const rows = await Promise.all(
    services.map(async (s) => {
      const account = await getAccountByService(db, s.id);
      return {
        ...s,
        connected: account !== null,
        // A connected account whose session expired must not read as healthy.
        needsReauth: account?.status === "needs_reauth",
        consented: await hasConsent(db, s.id),
        disabledReason: await connectorDisabledReason(db, s.id),
      };
    }),
  );

  return (
    <main>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1>Dashboard</h1>
        <Link href="/activity" style={{ fontSize: 14 }}>
          Activity &amp; history →
        </Link>
      </div>

      <section style={{ marginTop: 16 }}>
        <h2>Services</h2>
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((s) => (
            <div
              key={s.id}
              className="uc-card"
              style={{ display: "grid", gap: 4 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{s.displayName}</strong>
                <div style={{ color: "var(--uc-text-muted)", fontSize: 14 }}>
                  {s.needsReauth
                    ? "Session expired — needs reconnecting"
                    : s.connected
                      ? "Connected"
                      : "Not connected"}
                  {s.disabledReason && (
                    <span className="uc-warning"> · automatic runs paused</span>
                  )}
                </div>
              </div>
              {s.needsReauth ? (
                <Link href={`/connect/${s.id}`}>Reconnect</Link>
              ) : s.connected ? (
                <span style={{ color: "var(--uc-success)" }}>✓</span>
              ) : (
                <Link href={`/connect/${s.id}`}>Connect</Link>
              )}
              </div>
              {s.disabledReason && (
                <EnableConnector serviceId={s.id} reason={s.disabledReason} />
              )}
            </div>
          ))}
        </div>
      </section>

      <ClaimPanel />
    </main>
  );
}
