import { z } from "zod";

/** Request schemas shared by API routes and validated by the API contract test. */

export const setupSchema = z.object({
  password: z.string().min(8),
  recovery: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .length(3)
    .optional(),
  webhook: z
    .object({ kind: z.enum(["discord", "telegram", "ntfy"]), url: z.string().url() })
    .optional(),
});

export const loginSchema = z.object({ password: z.string().min(1) });

export const recoverSchema = z.object({
  answers: z.array(z.string()).length(3),
  newPassword: z.string().min(8),
});

export const consentSchema = z.object({ accepted: z.literal(true) });

/** Shape of a job as delivered by the jobs API and the SSE stream. */
export const jobViewSchema = z.object({
  id: z.string(),
  connectedAccountId: z.string(),
  serviceId: z.string(),
  state: z.enum(["queued", "running", "requires_human_action", "succeeded", "failed"]),
  outcome: z.enum(["claimed", "nothing_to_claim", "failed", "reauth_needed"]).nullable(),
  summary: z.string().nullable(),
});

/** SSE event payload pushed to the dashboard. */
export const sseJobsEventSchema = z.object({
  type: z.literal("jobs"),
  jobs: z.array(jobViewSchema),
});

/** Set/replace a recurring schedule for an account (feature 002). */
export const scheduleSchema = z
  .object({
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    enabled: z.boolean(),
  })
  .refine((d) => d.frequency !== "weekly" || d.dayOfWeek != null, {
    message: "weekly schedule requires a dayOfWeek (0-6)",
  });

/** An operator input event relayed to a login session (assisted login). */
export const loginInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal("type"), text: z.string() }),
  z.object({ kind: z.literal("key"), key: z.string() }),
  z.object({ kind: z.literal("scroll"), dy: z.number() }),
]);

export const connectAccountSchema = z.discriminatedUnion("method", [
  z.object({
    serviceId: z.string(),
    method: z.literal("session_import"),
    cookiesText: z.string().optional(),
    cookiesJson: z.string().optional(),
    config: z.record(z.string()).optional(),
    proxy: z.string().optional(),
  }),
  z.object({
    serviceId: z.string(),
    method: z.literal("credential_totp"),
    email: z.string().email(),
    password: z.string().min(1),
    totpSeed: z.string().optional(),
    config: z.record(z.string()).optional(),
    proxy: z.string().optional(),
  }),
]);

/** Validate provided config against a connector's required fields; returns missing keys. */
export function missingConfigKeys(
  fields: { key: string; required: boolean }[] | undefined,
  provided: Record<string, string> | undefined,
): string[] {
  if (!fields) return [];
  const cfg = provided ?? {};
  return fields.filter((f) => f.required && !(cfg[f.key] ?? "").trim()).map((f) => f.key);
}
