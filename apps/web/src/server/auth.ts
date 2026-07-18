import { hash, verify } from "@node-rs/argon2";

/**
 * Password / security-answer hashing with argon2id (best practice). Used for the single
 * admin credential and, when enabled, the three recovery-question answers.
 */

export function hashSecret(plaintext: string): Promise<string> {
  return hash(plaintext, { algorithm: 2 /* argon2id */ });
}

export async function verifySecret(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

/** Normalize a security-question answer before hashing/verifying (case/space-insensitive). */
export function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, " ");
}
