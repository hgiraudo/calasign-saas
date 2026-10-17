// TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 dígitos) — compatible con Google Authenticator, Authy, 1Password, etc.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Verifica un código con tolerancia de ±1 paso (reloj del teléfono desfasado).
 * Devuelve el paso que coincidió (para impedir la reutilización del mismo código) o null.
 */
export function verifyTotp(secretB32: string, code: string, opts: { lastStep?: number | null; now?: number } = {}): number | null {
  const c = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep(opts.now);
  for (const step of [now - 1, now, now + 1]) {
    if (opts.lastStep != null && step <= opts.lastStep) continue;
    const expected = totpAt(secretB32, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = "CalaSign") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}

/** Códigos de recuperación legibles: xxxx-xxxx-xx (10 caracteres, sin ambiguos). */
export function generateRecoveryCodes(n = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 10)}`;
  });
}

export function normalizeRecoveryCode(code: string) {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
