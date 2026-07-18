import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { connectorRun, connectorState } from "./schema.js";

export interface RecordRunInput {
  serviceId: string;
  connectorVersion: string;
  success: boolean;
  outcome: string;
}

/** Record the outcome of a connector run (feeds the failure-rate monitor). */
export async function recordConnectorRun(db: Database, input: RecordRunInput): Promise<void> {
  await db.insert(connectorRun).values(input);
}

/** Failure rate over the most recent `window` runs (0..1); null if too few runs. */
export async function connectorFailureRate(
  db: Database,
  serviceId: string,
  window = 20,
  minRuns = 5,
): Promise<number | null> {
  const runs = await db
    .select({ success: connectorRun.success })
    .from(connectorRun)
    .where(eq(connectorRun.serviceId, serviceId))
    .orderBy(desc(connectorRun.ranAt))
    .limit(window);
  if (runs.length < minRuns) return null;
  const failures = runs.filter((r) => !r.success).length;
  return failures / runs.length;
}

/**
 * Auto-disable a connector whose recent failure rate exceeds `threshold` (Principle I).
 * Returns true if the connector is (now) disabled.
 */
export async function evaluateConnectorHealth(
  db: Database,
  serviceId: string,
  threshold = 0.5,
): Promise<boolean> {
  const rate = await connectorFailureRate(db, serviceId);
  if (rate === null) return false;
  if (rate >= threshold) {
    await setConnectorDisabled(db, serviceId, true, `failure rate ${(rate * 100).toFixed(0)}%`);
    return true;
  }
  return false;
}

export async function setConnectorDisabled(
  db: Database,
  serviceId: string,
  disabled: boolean,
  reason?: string,
): Promise<void> {
  await db
    .insert(connectorState)
    .values({ serviceId, disabled, disabledReason: reason ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: connectorState.serviceId,
      set: { disabled, disabledReason: reason ?? null, updatedAt: new Date() },
    });
}

export async function isConnectorDisabled(db: Database, serviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ disabled: connectorState.disabled })
    .from(connectorState)
    .where(eq(connectorState.serviceId, serviceId))
    .limit(1);
  return row?.disabled ?? false;
}
