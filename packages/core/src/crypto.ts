import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Thrown when a ciphertext cannot be authenticated — almost always because the configured
 * APP_ENCRYPTION_KEY does not match the key used to encrypt the stored data. Surfaced as a
 * clear configuration error rather than an opaque crash (spec edge case).
 */
export class EncryptionKeyMismatchError extends Error {
  constructor(message = "encryption key does not match stored data (APP_ENCRYPTION_KEY)") {
    super(message);
    this.name = "EncryptionKeyMismatchError";
  }
}

/** Decode and validate the base64 master key from configuration. */
export function loadMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to ${KEY_LEN} bytes (got ${key.length}); ` +
        `generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * A stable, non-reversible identifier for a master key, so a deployment can tell whether the key
 * it has been given is the one its stored data was encrypted with.
 *
 * Domain-separated and truncated: it is written to the database, and the point is to compare two
 * keys for equality, not to publish anything that helps recover one. SHA-256 over a labelled
 * input means this digest cannot be reused as, or confused with, any other hash of the same key.
 */
export function masterKeyFingerprint(masterKey: Buffer): string {
  return createHash("sha256")
    .update("uc-master-key-fingerprint:")
    .update(masterKey)
    .digest("hex")
    .slice(0, 32);
}

function encryptWithKey(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function decryptWithKey(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new EncryptionKeyMismatchError("ciphertext is too short to be valid");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new EncryptionKeyMismatchError();
  }
}

/**
 * A sealed secret, split into the two columns stored on `connected_account`:
 * - `ciphertext`      -> secret_ciphertext
 * - `wrappedDataKey`  -> secret_data_key
 * Envelope scheme: a random per-record data key encrypts the payload; the master key wraps
 * the data key. This limits blast radius and allows future master-key rotation.
 */
export interface SealedSecret {
  ciphertext: Buffer;
  wrappedDataKey: Buffer;
}

/** Encrypt a secret with a fresh per-record data key wrapped by the master key. */
export function sealSecret(plaintext: string | Buffer, masterKey: Buffer): SealedSecret {
  const dataKey = randomBytes(KEY_LEN);
  const payload = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = encryptWithKey(dataKey, payload);
  const wrappedDataKey = encryptWithKey(masterKey, dataKey);
  // Best-effort scrub of the plaintext data key from memory.
  dataKey.fill(0);
  return { ciphertext, wrappedDataKey };
}

/** Decrypt a sealed secret. Throws {@link EncryptionKeyMismatchError} on key/tag mismatch. */
export function openSecret(sealed: SealedSecret, masterKey: Buffer): Buffer {
  const dataKey = decryptWithKey(masterKey, sealed.wrappedDataKey);
  try {
    return decryptWithKey(dataKey, sealed.ciphertext);
  } finally {
    dataKey.fill(0);
  }
}

/** Convenience wrapper returning the decrypted secret as a UTF-8 string. */
export function openSecretString(sealed: SealedSecret, masterKey: Buffer): string {
  return openSecret(sealed, masterKey).toString("utf8");
}

/** Constant-time comparison of two UTF-8 strings (for tokens/answers). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
