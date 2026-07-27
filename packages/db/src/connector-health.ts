import { and, desc, eq, gt } from "drizzle-orm";
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

/**
 * Failure rate over the most recent `window` runs (0..1); null if too few runs.
 *
 * `since` discards everything before it. That matters after a connector is re-enabled: the
 * old failures describe a problem that has just been fixed (a dead session, say), and counting
 * them would disable the connector again on its very next run.
 */
export async function connectorFailureRate(
  db: Database,
  serviceId: string,
  window = 20,
  minRuns = 5,
  since?: Date | null,
): Promise<number | null> {
  const scope = since
    ? and(eq(connectorRun.serviceId, serviceId), gt(connectorRun.ranAt, since))
    : eq(connectorRun.serviceId, serviceId);
  const runs = await db
    .select({ success: connectorRun.success })
    .from(connectorRun)
    .where(scope)
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
  // Only judge runs since the connector was last re-enabled.
  const resetAt = await connectorResetAt(db, serviceId);
  const rate = await connectorFailureRate(db, serviceId, 20, 5, resetAt);
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

/**
 * When the connector was last explicitly re-enabled, or null if it never was. Used to ignore
 * the failures that led to the previous auto-disable.
 */
export async function connectorResetAt(db: Database, serviceId: string): Promise<Date | null> {
  const [row] = await db
    .select({ disabled: connectorState.disabled, updatedAt: connectorState.updatedAt })
    .from(connectorState)
    .where(eq(connectorState.serviceId, serviceId))
    .limit(1);
  return row && !row.disabled ? row.updatedAt : null;
}

/**
 * Clear an auto-disable. Called when the operator reconnects an account (the usual cause is a
 * session that stopped working) and from the dashboard's explicit re-enable action. Runs before
 * this point stop counting towards the failure rate — see connectorFailureRate.
 */
export async function reenableConnector(db: Database, serviceId: string): Promise<void> {
  await setConnectorDisabled(db, serviceId, false);
}

/** Why a connector is disabled, or null when it is healthy. */
export async function connectorDisabledReason(
  db: Database,
  serviceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ disabled: connectorState.disabled, reason: connectorState.disabledReason })
    .from(connectorState)
    .where(eq(connectorState.serviceId, serviceId))
    .limit(1);
  return row?.disabled ? (row.reason ?? "repeated failures") : null;
}