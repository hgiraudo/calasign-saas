// lib/util.ts, la base criptográfica de la API (docs/estandares/tests-automatizados.md §8): AES-256-GCM con la clave
// de la aplicación, HMAC con separación de dominios, scrypt de las contraseñas, el JSON canónico de la cadena de
// evidencia y los helpers que deciden qué credencial o ruta llega. Cada caso afirma algo que un mutante de Stryker
// rompía sin que otro test lo notara. La clave es sintética (32 bytes de 0x07), armada en el test.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Util = typeof import("../src/lib/util");

const KEY = Buffer.alloc(32, 7);

/** util.ts recién importado con esa configuración (la clave queda en caché por módulo). */
async function utilWith(cfg: { secretKey?: string | null; production?: boolean; dataDir?: string }): Promise<Util> {
  vi.resetModules();
  vi.doMock("../src/config", () => ({
    config: { secretKey: null, production: false, dataDir: mkdtempSync(join(tmpdir(), "calasign-util-")), ...cfg },
  }));
  return import("../src/lib/util");
}
const withKey = () => utilWith({ secretKey: KEY.toString("base64") });

afterEach(() => {
  vi.doUnmock("../src/config");
  vi.useRealTimers();
});

describe("clave de la aplicación (SECRET_KEY o var/secret.key)", () => {
  it("con SECRET_KEY cifra con esa clave: se descifra a mano con ella", async () => {
    const u = await withKey();
    const [v, iv, enc, tag] = u.encrypt("hola").split(".");
    expect(v).toBe("v1");
    const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, "base64url"));
    expect(Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString()).toBe("hola");
  });

  it("una SECRET_KEY que no mide 32 bytes no arranca", async () => {
    const u = await utilWith({ secretKey: Buffer.alloc(16, 1).toString("base64") });
    expect(() => u.encrypt("x")).toThrow("SECRET_KEY debe ser de 32 bytes en base64");
  });

  it("en producción sin SECRET_KEY no genera una clave: falla", async () => {
    const u = await utilWith({ production: true });
    expect(() => u.encrypt("x")).toThrow("SECRET_KEY es obligatoria en producción");
  });

  it("fuera de producción sin SECRET_KEY genera var/secret.key (32 bytes, sólo legible por el dueño) y la reusa", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "calasign-util-"));
    const u = await utilWith({ dataDir });
    const sealed = u.encrypt("persistente");
    const file = join(dataDir, "secret.key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(file, "utf8").trim(), "base64")).toHaveLength(32);
    // Otro proceso (módulo nuevo) lee la misma clave: lo cifrado antes se descifra.
    const u2 = await utilWith({ dataDir });
    expect(u2.decrypt(sealed)).toBe("persistente");
  });

  it("una var/secret.key existente (con salto de línea al final) se usa y no se pisa", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "calasign-util-"));
    writeFileSync(join(dataDir, "secret.key"), `${KEY.toString("base64")}\n`);
    const u = await utilWith({ dataDir });
    expect(u.hmacSign("p", "d")).toBe((await withKey()).hmacSign("p", "d"));
    expect(readFileSync(join(dataDir, "secret.key"), "utf8")).toBe(`${KEY.toString("base64")}\n`);
  });
});

describe("encrypt / decrypt (texto)", () => {
  it("formato v1.<iv 12 bytes>.<datos>.<tag 16 bytes>, IV distinto cada vez, ida y vuelta con UTF-8", async () => {
    const u = await withKey();
    const a = u.encrypt("contraseña ñandú ✓");
    const b = u.encrypt("contraseña ñandú ✓");
    expect(a).not.toBe(b);
    const [, iv, , tag] = a.split(".");
    expect(Buffer.from(iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(tag, "base64url")).toHaveLength(16);
    expect(u.decrypt(a)).toBe("contraseña ñandú ✓");
    expect(u.decrypt(u.encrypt(""))).toBe("");
  });

  it("rechaza otra versión, un tag ausente o recortado y un cifrado alterado", async () => {
    const u = await withKey();
    const [, iv, enc, tag] = u.encrypt("secreto").split(".");
    expect(() => u.decrypt(`v2.${iv}.${enc}.${tag}`)).toThrow("formato de cifrado desconocido");
    expect(() => u.decrypt(`v1.${iv}.${enc}`)).toThrow("etiqueta de cifrado inválida");
    const short = Buffer.from(tag, "base64url").subarray(0, 12).toString("base64url");
    expect(() => u.decrypt(`v1.${iv}.${enc}.${short}`)).toThrow("etiqueta de cifrado inválida");
    const flipped = Buffer.from(enc, "base64url");
    flipped[0] ^= 1;
    expect(() => u.decrypt(`v1.${iv}.${flipped.toString("base64url")}.${tag}`)).toThrow();
  });

  it("acepta lo cifrado por otro proceso con la misma clave (no depende del estado del módulo)", async () => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", KEY, iv);
    const enc = Buffer.concat([c.update("de afuera", "utf8"), c.final()]);
    const payload = `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
    expect((await withKey()).decrypt(payload)).toBe("de afuera");
  });
});

describe("encryptBytes / decryptBytes (binarios)", () => {
  it("iv(12) ‖ tag(16) ‖ datos con la clave de la aplicación", async () => {
    const u = await withKey();
    const plain = new Uint8Array([0, 1, 2, 250, 255]);
    const out = Buffer.from(u.encryptBytes(plain));
    expect(out).toHaveLength(12 + 16 + plain.length);
    const d = createDecipheriv("aes-256-gcm", KEY, out.subarray(0, 12), { authTagLength: 16 });
    d.setAuthTag(out.subarray(12, 28));
    expect(Buffer.concat([d.update(out.subarray(28)), d.final()])).toEqual(Buffer.from(plain));
    expect(Buffer.from(u.decryptBytes(out))).toEqual(Buffer.from(plain));
  });

  it("un byte alterado (datos o tag) no descifra", async () => {
    const u = await withKey();
    const out = Buffer.from(u.encryptBytes(new Uint8Array([9, 9, 9, 9])));
    for (const i of [13, out.length - 1]) {
      const bad = Buffer.from(out);
      bad[i] ^= 1;
      expect(() => u.decryptBytes(bad)).toThrow();
    }
  });
});

describe("hmacSign / hmacEqual", () => {
  it("HMAC con una clave derivada por propósito: la firma de un propósito no vale para otro", async () => {
    const u = await withKey();
    const derived = createHmac("sha256", KEY).update("calasign:mcp-confirm").digest();
    expect(u.hmacSign("mcp-confirm", "datos")).toBe(createHmac("sha256", derived).update("datos").digest("base64url"));
    expect(u.hmacSign("otro", "datos")).not.toBe(u.hmacSign("mcp-confirm", "datos"));
  });

  it("hmacEqual: igual, distinto del mismo largo y de otro largo (sin lanzar)", async () => {
    const u = await withKey();
    const s = u.hmacSign("p", "d");
    expect(u.hmacEqual(s, s)).toBe(true);
    expect(u.hmacEqual(s, `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`)).toBe(false);
    expect(u.hmacEqual(s, s.slice(0, -1))).toBe(false);
    expect(u.hmacEqual("", "")).toBe(true);
  });
});

describe("contraseñas (scrypt)", () => {
  it("hashPassword: scrypt$N$r$p$sal$clave con N=2^15, r=8, p=1, sal de 16 y clave de 32 bytes; verifica", async () => {
    const u = await withKey();
    const stored = await u.hashPassword("correcta-caballo-bateria");
    const [alg, N, r, p, salt, key] = stored.split("$");
    expect([alg, N, r, p]).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(salt, "base64")).toHaveLength(16);
    expect(Buffer.from(key, "base64")).toEqual(
      scryptSync("correcta-caballo-bateria", Buffer.from(salt, "base64"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
    );
    expect(await u.verifyPassword("correcta-caballo-bateria", stored)).toBe(true);
    expect(await u.verifyPassword("correcta-caballo-bateriA", stored)).toBe(false);
    expect(await u.hashPassword("correcta-caballo-bateria")).not.toBe(stored);
  });

  it("verifyPassword usa los parámetros y el largo guardados (hashes con otros N/r/p siguen valiendo)", async () => {
    const u = await withKey();
    const salt = Buffer.alloc(16, 3);
    const key = scryptSync("vieja-clave-123", salt, 64, { N: 1024, r: 4, p: 2 });
    const stored = `scrypt$1024$4$2$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await u.verifyPassword("vieja-clave-123", stored)).toBe(true);
    expect(await u.verifyPassword("vieja-clave-124", stored)).toBe(false);
  });

  it("otro algoritmo: false sin calcular nada", async () => {
    const u = await withKey();
    const stored = await u.hashPassword("x-cualquiera");
    expect(await u.verifyPassword("x-cualquiera", stored.replace(/^scrypt/, "bcrypt"))).toBe(false);
  });
});

describe("canonicalJson (la cadena de hashes de la evidencia)", () => {
  it("claves ordenadas en todos los niveles, sin las undefined, arrays en orden", async () => {
    const { canonicalJson } = await withKey();
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("escalares, null, undefined, fechas y strings con comillas como JSON", async () => {
    const { canonicalJson } = await withKey();
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson([undefined, null, 1])).toBe("[null,null,1]");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson('di "hola"\n')).toBe('"di \\"hola\\"\\n"');
    expect(canonicalJson({ 'k"': new Date("2026-11-03T10:00:00.000Z") })).toBe('{"k\\"":"2026-11-03T10:00:00.000Z"}');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson({ n: null })).toBe('{"n":null}');
  });
});

describe("identificadores y hashes", () => {
  it("sha256Hex: vector conocido, string y bytes", async () => {
    const { sha256Hex } = await withKey();
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array([97, 98, 99]))).toBe(sha256Hex("abc"));
  });

  it("uuidv5: el vector del RFC 4122 (www.example.com en el namespace DNS)", async () => {
    const { uuidv5 } = await withKey();
    expect(uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("uuidv7: versión 7, variante RFC, los primeros 48 bits son el timestamp y el resto es aleatorio", async () => {
    const { uuidv7 } = await withKey();
    vi.useFakeTimers({ now: 0x0123456789ab });
    const ids = Array.from({ length: 64 }, () => uuidv7());
    for (const id of ids) expect(id).toMatch(/^01234567-89ab-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(64);
    // El nibble bajo del byte 6 (después del 7) y los bits libres del byte 8 son aleatorios, no ceros fijos.
    expect(new Set(ids.map((id) => id[15])).size).toBeGreaterThan(1);
    expect(new Set(ids.map((id) => id[19])).size).toBeGreaterThan(1);
  });

  it("randomToken: 256 bits en base64url por defecto, otro largo si se pide", async () => {
    const { randomToken } = await withKey();
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(Buffer.from(randomToken(16), "base64url")).toHaveLength(16);
    expect(randomToken()).not.toBe(t);
  });
});

describe("credenciales y rutas del pedido", () => {
  it("bearerToken: esquema sin distinguir mayúsculas, espacios, token vacío y otros esquemas", async () => {
    const { bearerToken } = await withKey();
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("BEARER   abc  ")).toBe("abc");
    expect(bearerToken("Bearer a\nb")).toBe("a\nb");
    expect(bearerToken("Bearer   ")).toBeNull();
    expect(bearerToken("Bearerabc")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("x Bearer abc")).toBeNull();
    expect(bearerToken(["Bearer abc"])).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it("requestPath: decodifica como el router, sin query ni fragmento; una ruta mal codificada queda cruda", async () => {
    const { requestPath } = await withKey();
    expect(requestPath({ url: "/%761/me?x=1" })).toBe("/v1/me");
    expect(requestPath({ url: "/v1/a#frag" })).toBe("/v1/a");
    expect(requestPath({ url: "/v1/%E0%A4%A?x" })).toBe("/v1/%E0%A4%A");
  });

  it("hostOf: el host (con puerto) sin ruta ni query; null si no es una URL", async () => {
    const { hostOf } = await withKey();
    expect(hostOf("https://hooks.example.com:8443/x?token=s3")).toBe("hooks.example.com:8443");
    expect(hostOf("no es url")).toBeNull();
  });
});

describe("helpers de texto", () => {
  it("queryList: comas, claves repetidas (array), espacios y vacíos", async () => {
    const { queryList } = await withKey();
    expect(queryList("a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(queryList(["a,b", "c", 3])).toEqual(["a", "b", "c"]);
    expect(queryList(undefined)).toEqual([]);
  });

  it("likeContains: %, _ y \\ se buscan literales", async () => {
    const { likeContains } = await withKey();
    expect(likeContains("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
    expect(likeContains("abc")).toBe("%abc%");
  });

  it("iso: fecha o string a ISO; vacío a null", async () => {
    const { iso } = await withKey();
    expect(iso(new Date("2026-11-03T00:00:00Z"))).toBe("2026-11-03T00:00:00.000Z");
    expect(iso("2026-11-03T00:00:00Z")).toBe("2026-11-03T00:00:00.000Z");
    expect(iso(null)).toBeNull();
    expect(iso("")).toBeNull();
  });

  it("slugify: sin acentos, minúsculas, guiones, sin guiones en los bordes, 40 caracteres; vacío da org", async () => {
    const { slugify } = await withKey();
    expect(slugify("  Árbol & Compañía S.A.  ")).toBe("arbol-compania-s-a");
    expect(slugify("x".repeat(50))).toHaveLength(40);
    expect(slugify("¡¡!!")).toBe("org");
  });

  it("maskDestination: correo con 2 letras y el dominio, teléfono con 4 + 2, corto entero oculto", async () => {
    const { maskDestination } = await withKey();
    expect(maskDestination("ana.perez@example.com")).toBe("an***@example.com");
    expect(maskDestination("+5491155551234")).toBe("+549***34");
    expect(maskDestination("1234567")).toBe("1234***67");
    expect(maskDestination("123456")).toBe("***");
  });
});
