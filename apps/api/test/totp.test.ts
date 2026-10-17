import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "../src/lib/totp";

describe("TOTP", () => {
  // Vector de prueba de RFC 6238 (SHA-1, secreto ASCII "12345678901234567890").
  const secret = base32Encode(Buffer.from("12345678901234567890"));

  it("codifica y decodifica base32", () => {
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });

  it("coincide con los vectores de RFC 6238", () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("acepta ±1 paso y rechaza códigos reutilizados", () => {
    const now = 1_234_567_890_000;
    const step = Math.floor(now / 30_000);
    const code = totpAt(secret, step - 1);
    expect(verifyTotp(secret, code, { now })).toBe(step - 1);
    expect(verifyTotp(secret, code, { now, lastStep: step - 1 })).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step - 3), { now })).toBeNull();
    expect(verifyTotp(secret, "abc123", { now })).toBeNull();
  });
});
