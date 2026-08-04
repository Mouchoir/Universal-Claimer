/**
 * Resolve the deployment's secrets once, and keep them.
 *
 * These used to live only in the compose file, which for a Portainer stack means they are pasted
 * into a web form. Re-pasting a YAML with a regenerated `APP_ENCRYPTION_KEY` is silent and fatal:
 * the app starts, and every stored account session is undecryptable from then on. Nothing about
 * updating a deployment should be able to do that.
 *
 * So the secrets are resolved from the environment first — an operator who pins them keeps
 * control, and existing deployments are unaffected — then from a file on a volume, and only
 * generated when neither has them. Whatever is resolved is written back, so removing the values
 * from the environment later is harmless rather than destructive.
 *
 * The generator and the file access are injected, so the precedence rules are unit-tested rather
 * than verified by redeploying and hoping.
 */

/** Secrets the deployment cannot start without, and how to make one. */
export const MANAGED_SECRETS = {
  /** Base64-encoded 32 bytes: the envelope-encryption master key. */
  APP_ENCRYPTION_KEY: "base64-32",
  /** Hex: shared secret for the internal worker→web relay leg. */
  RELAY_TOKEN: "hex-32",
} as const;

export type SecretName = keyof typeof MANAGED_SECRETS;
export type SecretKind = (typeof MANAGED_SECRETS)[SecretName];

export interface SecretFile {
  /** Stored contents, or null when nothing has been persisted yet. */
  read: () => string | null;
  write: (contents: string) => void;
}

export interface BootstrapResult {
  values: Record<SecretName, string>;
  /** Names that had to be generated — worth logging once, since they are new. */
  generated: SecretName[];
  /** Whether anything was written back to the file. */
  persisted: boolean;
}

/** Parse the persisted file, tolerating absence and corruption alike. */
function readStored(file: SecretFile): Partial<Record<SecretName, string>> {
  const raw = file.read();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<SecretName, string>> = {};
    for (const name of Object.keys(MANAGED_SECRETS) as SecretName[]) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === "string" && value.length > 0) out[name] = value;
    }
    return out;
  } catch {
    // A truncated or hand-edited file must not be treated as "no secrets", which would generate
    // new ones and orphan the data. Returning {} here would do exactly that — but the key guard
    // downstream refuses to run against a mismatched key, so the failure stays loud.
    return {};
  }
}

export function bootstrapSecrets(
  env: Record<string, string | undefined>,
  file: SecretFile,
  generate: (kind: SecretKind) => string,
): BootstrapResult {
  const stored = readStored(file);
  const values = {} as Record<SecretName, string>;
  const generated: SecretName[] = [];

  for (const name of Object.keys(MANAGED_SECRETS) as SecretName[]) {
    const fromEnv = env[name]?.trim();
    if (fromEnv) {
      values[name] = fromEnv;
      continue;
    }
    const fromFile = stored[name];
    if (fromFile) {
      values[name] = fromFile;
      continue;
    }
    values[name] = generate(MANAGED_SECRETS[name]);
    generated.push(name);
  }

  // Write back whenever the file does not already say exactly this. That includes values that
  // came from the environment: persisting them is what makes removing them later safe.
  const changed = (Object.keys(values) as SecretName[]).some((n) => stored[n] !== values[n]);
  if (changed) file.write(`${JSON.stringify(values, null, 2)}\n`);

  return { values, generated, persisted: changed };
}
