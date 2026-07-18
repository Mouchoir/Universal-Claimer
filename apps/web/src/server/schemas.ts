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
  }),
  z.object({
    serviceId: z.string(),
    method: z.literal("credential_totp"),
    email: z.string().email(),
    password: z.string().min(1),
    totpSeed: z.string().optional(),
  }),
]);
