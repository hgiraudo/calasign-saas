import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config } from "../config";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/** UUIDv7: ordenado por tiempo (buena localidad de índice). */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUIDv5 (RFC 4122, SHA-1 sobre namespace + nombre): el mismo nombre da siempre el mismo id. */
export function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const b = createHash("sha1").update(ns).update(name, "utf8").digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Token aleatorio URL-safe de 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ───────────── Contraseñas (scrypt) ─────────────

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(expected, got);
}

// ───────────── Cifrado simétrico (AES-256-GCM) ─────────────

let secretKey: Buffer | null = null;

function getSecretKey(): Buffer {
  if (secretKey) return secretKey;
  if (config.secretKey) {
    secretKey = Buffer.from(config.secretKey, "base64");
  } else {
    if (config.production) throw new Error("SECRET_KEY es obligatoria en producción");
    const file = resolve(config.dataDir, "secret.key");
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    secretKey = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  }
  if (secretKey.length !== 32) throw new Error("SECRET_KEY debe ser de 32 bytes en base64");
  return secretKey;
}

/**
 * HMAC-SHA256 (base64url) con una clave derivada de SECRET_KEY para `purpose` (separación de dominios: una firma de
 * un propósito no vale para otro). Para tokens firmados de corta vida (p. ej. la confirmación de acciones del MCP).
 */
export function hmacSign(purpose: string, data: string): string {
  const key = createHmac("sha256", getSecretKey()).update(`calasign:${purpose}`).digest();
  return createHmac("sha256", key).update(data).digest("base64url");
}

/** Compara dos firmas de hmacSign en tiempo constante. */
export function hmacEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}

export function decrypt(payload: string): string {
  const [v, iv, enc, tag] = payload.split(".");
  if (v !== "v1") throw new Error("formato de cifrado desconocido");
  // Etiqueta completa (16 bytes): GCM acepta etiquetas truncadas (hasta 4 bytes) si no se fija el largo, y algunos
  // valores cifrados llegan del público (token de formulario web, state de OAuth).
  const authTag = Buffer.from(tag ?? "", "base64url");
  if (authTag.length !== 16) throw new Error("etiqueta de cifrado inválida");
  const d = createDecipheriv("aes-256-gcm", getSecretKey(), Buffer.from(iv, "base64url"), { authTagLength: 16 });
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

/** Cifra un binario con la clave de la aplicación (AES-256-GCM): iv(12) ‖ tag(16) ‖ datos. */
export function encryptBytes(plain: Uint8Array): Uint8Array {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), enc]));
}

export function decryptBytes(payload: Uint8Array): Uint8Array {
  const b = Buffer.from(payload);
  const d = createDecipheriv("aes-256-gcm", getSecretKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
}

// ───────────── JSON canónico (para la cadena de hashes) ─────────────

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * Lista de un parámetro de la query separada por comas. Fastify convierte una clave repetida (?status=a&status=b) en un
 * array: sin esto, `.split(",")` sobre ese array respondía 500. Se aceptan las dos formas (y mezcladas).
 */
export function queryList(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v])
    .flatMap((x) => (typeof x === "string" ? x.split(",") : []))
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Patrón de ILIKE "contiene" para un texto buscado: %, _ y \ se escapan (se buscan literales, no como comodines).
 * Usar con ESCAPE '\' en la consulta.
 */
export function likeContains(q: string): string {
  return `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

export function maskDestination(d: string): string {
  if (d.includes("@")) {
    const [u, dom] = d.split("@");
    return `${u.slice(0, 2)}***@${dom}`;
  }
  return d.length > 6 ? `${d.slice(0, 4)}***${d.slice(-2)}` : "***";
}

/**
 * Ruta del pedido decodificada como la decodifica el router (find-my-way aplica decodeURI antes de buscar la ruta).
 * Los controles por prefijo sobre req.url crudo se salteaban con percent-encoding: "/%761/me" llega a "/v1/me".
 */
export function requestPath(req: { url: string }): string {
  const raw = req.url.split(/[?#]/)[0];
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}
