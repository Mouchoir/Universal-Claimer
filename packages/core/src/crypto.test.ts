import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EncryptionKeyMismatchError,
  loadMasterKey,
  openSecret,
  openSecretString,
  safeEqual,
  sealSecret,
} from "./crypto.js";

const masterKey = randomBytes(32);

describe("loadMasterKey", () => {
  it("accepts a base64 32-byte key", () => {
    const key = loadMasterKey(masterKey.toString("base64"));
    expect(key.length).toBe(32);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => loadMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("sealSecret / openSecret", () => {
  it("round-trips a string secret", () => {
    const sealed = sealSecret("super-secret-cookie", masterKey);
    expect(openSecretString(sealed, masterKey)).toBe("super-secret-cookie");
  });

  it("round-trips a binary secret", () => {
    const data = randomBytes(200);
    const sealed = sealSecret(data, masterKey);
    expect(openSecret(sealed, masterKey).equals(data)).toBe(true);
  });

  it("produces different ciphertext for the same plaintext (random data key + IV)", () => {
    const a = sealSecret("same", masterKey);
    const b = sealSecret("same", masterKey);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDataKey.equals(b.wrappedDataKey)).toBe(false);
  });

  it("never stores the plaintext inside the ciphertext", () => {
    const sealed = sealSecret("plaintext-marker", masterKey);
    expect(sealed.ciphertext.toString("utf8")).not.toContain("plaintext-marker");
  });

  it("throws EncryptionKeyMismatchError when the master key is wrong", () => {
    const sealed = sealSecret("x", masterKey);
    expect(() => openSecret(sealed, randomBytes(32))).toThrow(EncryptionKeyMismatchError);
  });

  it("throws EncryptionKeyMismatchError when the ciphertext is tampered", () => {
    const sealed = sealSecret("x", masterKey);
    sealed.ciphertext[sealed.ciphertext.length - 1] ^= 0xff;
    expect(() => openSecret(sealed, masterKey)).toThrow(EncryptionKeyMismatchError);
  });
});

describe("safeEqual", () => {
  it("is true for equal strings and false otherwise", () => {
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "other")).toBe(false);
    expect(safeEqual("token", "tokenlonger")).toBe(false);
  });
});
