import { authenticator } from "otplib";

/** Generate the current TOTP code for a base32 seed (credential_totp login path). */
export function generateTotp(seed: string): string {
  return authenticator.generate(seed.replace(/\s+/g, ""));
}

/** Verify a TOTP code against a seed (used in tests / fixtures). */
export function verifyTotp(token: string, seed: string): boolean {
  return authenticator.check(token, seed.replace(/\s+/g, ""));
}
