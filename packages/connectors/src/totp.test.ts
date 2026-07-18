import { describe, expect, it } from "vitest";
import { generateTotp, verifyTotp } from "./totp.js";

// A known base32 seed.
const SEED = "JBSWY3DPEHPK3PXP";

describe("totp", () => {
  it("generates a 6-digit code that verifies against its seed", () => {
    const code = generateTotp(SEED);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(code, SEED)).toBe(true);
  });

  it("tolerates spaces in the seed", () => {
    const spaced = "JBSW Y3DP EHPK 3PXP";
    expect(generateTotp(spaced)).toBe(generateTotp(SEED));
  });

  it("rejects a wrong code", () => {
    expect(verifyTotp("000000", SEED) && generateTotp(SEED) === "000000").toBe(false);
  });
});
