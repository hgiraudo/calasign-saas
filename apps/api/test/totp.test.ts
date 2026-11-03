import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from "../src/lib/totp";

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

// Casos de mutation testing (tests-automatizados.md §8).
describe("base32 (RFC 4648 §10, sin relleno)", () => {
  const VECTORES: [string, string][] = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  it.each(VECTORES)("codifica %j como %j y vuelve", (claro, b32) => {
    expect(base32Encode(Buffer.from(claro))).toBe(b32);
    expect(base32Decode(b32).toString()).toBe(claro);
  });
  it("decodifica con relleno, minúsculas y espacios (como lo copia una persona)", () => {
    expect(base32Decode("MZXW6===").toString()).toBe("foo");
    expect(base32Decode("MY======").toString()).toBe("f");
    expect(base32Decode("mzxw 6ytb oi").toString()).toBe("foobar");
  });
  it("rechaza caracteres que no son base32, también un `=` en el medio", () => {
    expect(() => base32Decode("MZXW1")).toThrow("base32 inválido");
    expect(() => base32Decode("MZ=XW6")).toThrow("base32 inválido");
  });
  it("el secreto nuevo es de 20 bytes aleatorios", () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });
});

describe("verifyTotp: bordes", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const now = 1_234_567_890_000;
  const step = Math.floor(now / 30_000);
  it("acepta el paso anterior, el actual y el siguiente, y nada más", () => {
    expect(verifyTotp(secret, totpAt(secret, step), { now })).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step + 1), { now })).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), { now })).toBeNull();
  });
  it("acepta el código con espacios (`287 082`)", () => {
    const c = totpAt(secret, step);
    expect(verifyTotp(secret, `${c.slice(0, 3)} ${c.slice(3)}`, { now })).toBe(step);
  });
  it("un código que no son exactamente 6 dígitos da null, sin tirar", () => {
    const c = totpAt(secret, step);
    for (const malo of [c.slice(0, 5), `${c}0`, `x${c}`, `${c}x`, "", "abcdef"]) expect(verifyTotp(secret, malo, { now })).toBeNull();
  });
  it("con un paso ya usado, rechaza ese y los anteriores pero acepta los siguientes", () => {
    expect(verifyTotp(secret, totpAt(secret, step), { now, lastStep: step - 2 })).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step), { now, lastStep: step - 1 })).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step), { now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step + 1), { now, lastStep: step })).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step - 1), { now, lastStep: null })).toBe(step - 1);
  });
});

describe("otpauthUrl y códigos de recuperación", () => {
  it("arma el otpauth:// que leen las apps de autenticación", () => {
    expect(otpauthUrl("MZXW6", "ana@example.com")).toBe(
      "otpauth://totp/CalaSign%3Aana%40example.com?secret=MZXW6&issuer=CalaSign&algorithm=SHA1&digits=6&period=30",
    );
    expect(otpauthUrl("MZXW6", "ana@example.com", "Mi Marca & Co")).toBe(
      "otpauth://totp/Mi%20Marca%20%26%20Co%3Aana%40example.com?secret=MZXW6&issuer=Mi%20Marca%20%26%20Co&algorithm=SHA1&digits=6&period=30",
    );
  });
  it("genera 10 códigos xxxx-xxxx-xx distintos, sin caracteres ambiguos", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{2}$/);
    expect(new Set(codes).size).toBe(10);
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });
  it("normaliza un código como lo escribe una persona", () => {
    expect(normalizeRecoveryCode("  ABCD-efgh-23 ")).toBe("abcdefgh23");
    expect(normalizeRecoveryCode("abcd efgh 23")).toBe("abcdefgh23");
    const [c] = generateRecoveryCodes(1);
    expect(normalizeRecoveryCode(c.toUpperCase())).toBe(c.replace(/-/g, ""));
  });
});
