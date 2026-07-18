import { z } from "zod";

/**
 * Environment configuration. Only the minimal set of values that must exist before the
 * app boots lives here (Constitution: minimal Compose YAML). Everything else is configured
 * through the web onboarding wizard and stored (encrypted) in the database.
 */
export const envSchema = z.object({
  /** Base64-encoded 32-byte master key for envelope encryption (see crypto.ts). */
  APP_ENCRYPTION_KEY: z.string().min(1, "APP_ENCRYPTION_KEY is required"),
  /** Postgres connection string for the bundled database. */
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  /** Port the web app listens on. */
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Validate and parse environment configuration. Throws a readable aggregated error when
 * required values are missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
