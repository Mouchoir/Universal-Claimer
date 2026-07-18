import PgBoss from "pg-boss";
import type pg from "pg";
import { JOB_EVENTS_CHANNEL } from "./schema.js";

export const CLAIM_QUEUE = "claim";
export const LOGIN_QUEUE = "login";
export const SCHEDULER_QUEUE = "scheduler-tick";

export interface ClaimJobData {
  jobId: string;
  connectedAccountId: string;
  serviceId: string;
}

export interface LoginJobData {
  sessionId: string;
  serviceId: string;
}

/** Start a pg-boss instance on the shared Postgres (no extra infrastructure). */
export async function createQueue(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  // pg-boss v10 requires queues to exist before send()/work(). Idempotent.
  for (const q of [CLAIM_QUEUE, LOGIN_QUEUE, SCHEDULER_QUEUE]) {
    try {
      await boss.createQueue(q);
    } catch {
      /* queue already exists */
    }
  }
  return boss;
}

/**
 * Send options that enforce at most one running claim per account (FR-010): pg-boss uses
 * the singleton key to prevent a second active job with the same key.
 */
export function claimSendOptions(connectedAccountId: string): PgBoss.SendOptions {
  return { singletonKey: connectedAccountId, retryLimit: 0 };
}

export function loginSendOptions(sessionId: string): PgBoss.SendOptions {
  return { singletonKey: sessionId, retryLimit: 0 };
}

/** Notify listeners (the web app's SSE relay) that a job event occurred. */
export async function notifyJobEvent(pool: pg.Pool): Promise<void> {
  await pool.query("SELECT pg_notify($1, $2)", [JOB_EVENTS_CHANNEL, ""]);
}
