// AES-256-GCM con la clave de la aplicación: el tag tiene que medir 16 bytes. Sin authTagLength, Node acepta un tag
// de hasta 4 bytes, y uno de 4 bytes se adivina en 2^32 intentos (SAST: regla calasign-gcm-sin-largo-de-tag).
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-gcm-tag-"));
delete process.env.SECRET_KEY;

const util = await import("../src/lib/util");

/** iv(12) ‖ tag(n) ‖ datos, con el tag GCM correcto para esos datos pero recortado a n bytes. */
function payloadWithTruncatedTag(plain: Buffer, n: number): Uint8Array {
  util.encryptBytes(new Uint8Array([1])); // crea var/secret.key si no existe
  const key = Buffer.from(readFileSync(join(process.env.DATA_DIR!, "secret.key"), "utf8").trim(), "base64");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag().subarray(0, n), enc]));
}

describe("decryptBytes", () => {
  it("descifra lo que cifró encryptBytes", () => {
    const plain = new Uint8Array(Buffer.from("documento de identidad"));
    expect(Buffer.from(util.decryptBytes(util.encryptBytes(plain))).toString()).toBe("documento de identidad");
  });

  it("rechaza un tag de 4 bytes aunque sea el correcto (falsificable por fuerza bruta)", () => {
    // Sin datos: el payload es iv(12) ‖ tag(4), y antes decryptBytes tomaba esos 4 bytes como tag completo.
    const forged = payloadWithTruncatedTag(Buffer.alloc(0), 4);
    expect(forged.length).toBe(16);
    expect(() => util.decryptBytes(forged)).toThrow();
  });

  it("rechaza un payload adulterado", () => {
    const p = util.encryptBytes(new Uint8Array(Buffer.from("hola")));
    p[p.length - 1] ^= 1;
    expect(() => util.decryptBytes(p)).toThrow();
  });
});
