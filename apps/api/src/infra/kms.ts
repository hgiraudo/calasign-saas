// Acceso a AWS KMS con un factory inyectable (tests) y un KMS simulado determinista para el entorno local
// (KMS_MOCK=1): permite probar BYOK de punta a punta sin AWS. Las claves simuladas se derivan del ARN con
// la SECRET_KEY, así que sobreviven reinicios; un ARN que contiene "failing" o "disabled" simula una clave
// inutilizable.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config";
import { encrypt } from "../lib/util";

/** Subconjunto de comandos que usa la plataforma. */
export interface KmsLike {
  encrypt(i: { KeyId: string; Plaintext: Uint8Array; EncryptionContext?: Record<string, string> }): Promise<{ CiphertextBlob: Uint8Array; KeyId?: string }>;
  decrypt(i: { CiphertextBlob: Uint8Array; KeyId?: string; EncryptionContext?: Record<string, string> }): Promise<{ Plaintext: Uint8Array; KeyId?: string }>;
  generateDataKey(i: { KeyId: string; KeySpec: "AES_256"; EncryptionContext?: Record<string, string> }): Promise<{ Plaintext: Uint8Array; CiphertextBlob: Uint8Array; KeyId?: string }>;
  describeKey(i: { KeyId: string }): Promise<{ KeyMetadata?: { Enabled?: boolean; KeyState?: string; KeyUsage?: string; KeySpec?: string; Arn?: string } }>;
}

export class KmsUnavailableError extends Error {
  constructor(
    readonly keyArn: string,
    message: string,
  ) {
    super(message);
  }
}

/** Región de un ARN de KMS (arn:aws:kms:<región>:…). */
export function regionOfArn(arn: string): string | null {
  return /^arn:aws[a-z-]*:kms:([a-z0-9-]+):/.exec(arn)?.[1] ?? null;
}

// ───────────── Cliente real ─────────────

function awsKms(region: string): KmsLike {
  const p = import("@aws-sdk/client-kms").then((m) => ({ m, c: new m.KMSClient({ region }) }));
  return {
    async encrypt(i) {
      const { m, c } = await p;
      const r = await c.send(new m.EncryptCommand(i));
      return { CiphertextBlob: r.CiphertextBlob!, KeyId: r.KeyId };
    },
    async decrypt(i) {
      const { m, c } = await p;
      const r = await c.send(new m.DecryptCommand(i));
      return { Plaintext: r.Plaintext!, KeyId: r.KeyId };
    },
    async generateDataKey(i) {
      const { m, c } = await p;
      const r = await c.send(new m.GenerateDataKeyCommand(i));
      return { Plaintext: r.Plaintext!, CiphertextBlob: r.CiphertextBlob!, KeyId: r.KeyId };
    },
    async describeKey(i) {
      const { m, c } = await p;
      const r = await c.send(new m.DescribeKeyCommand(i));
      return { KeyMetadata: r.KeyMetadata as any };
    },
  };
}

// ───────────── KMS simulado (local y tests) ─────────────

let mockSecretCache: Buffer | null = null;
/** Secreto del KMS simulado: derivado de SECRET_KEY (o de var/secret.key, que util crea en local). */
function mockSecret(): Buffer {
  if (mockSecretCache) return mockSecretCache;
  encrypt("kms-mock"); // asegura que exista la clave local
  const raw = config.secretKey ?? readFileSync(resolve(config.dataDir, "secret.key"), "utf8").trim();
  mockSecretCache = createHmac("sha256", "calasign-kms-mock").update(raw).digest();
  return mockSecretCache;
}
function mockKeyFor(arn: string): Buffer {
  return createHmac("sha256", mockSecret()).update(`kms-mock:${arn}`).digest();
}
/** Claves simuladas deshabilitadas en tiempo de ejecución (solo local: POST /dev/kms-mock). */
const mockDisabled = new Set<string>();
export function setMockKeyDisabled(arn: string, disabled: boolean) {
  if (disabled) mockDisabled.add(arn);
  else mockDisabled.delete(arn);
}
const unusable = (arn: string) => /failing|disabled/i.test(arn) || mockDisabled.has(arn);
const ctxString = (c?: Record<string, string>) =>
  Object.keys(c ?? {})
    .sort()
    .map((k) => `${k}=${c![k]}`)
    .join("&");

/** Formato del blob simulado: "mock1" | len(arn) | arn | iv | tag | ciphertext. */
function mockWrap(arn: string, plain: Uint8Array, ctx?: Record<string, string>): Uint8Array {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", mockKeyFor(arn), iv);
  c.setAAD(Buffer.from(ctxString(ctx)));
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const a = Buffer.from(arn);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(a.length);
  return new Uint8Array(Buffer.concat([Buffer.from("mock1"), head, a, iv, c.getAuthTag(), enc]));
}

function mockUnwrap(blob: Uint8Array, ctx?: Record<string, string>): { plain: Uint8Array; arn: string } {
  const b = Buffer.from(blob);
  if (b.subarray(0, 5).toString() !== "mock1") throw new Error("InvalidCiphertextException");
  const n = b.readUInt16BE(5);
  const arn = b.subarray(7, 7 + n).toString();
  if (unusable(arn)) throw new Error(`KMSInvalidStateException: la clave ${arn} no está habilitada`);
  const iv = b.subarray(7 + n, 19 + n);
  const tag = b.subarray(19 + n, 35 + n);
  const d = createDecipheriv("aes-256-gcm", mockKeyFor(arn), iv);
  d.setAAD(Buffer.from(ctxString(ctx)));
  d.setAuthTag(tag);
  try {
    return { plain: new Uint8Array(Buffer.concat([d.update(b.subarray(35 + n)), d.final()])), arn };
  } catch {
    throw new Error("InvalidCiphertextException: el contexto de cifrado no coincide");
  }
}

export function mockKms(): KmsLike {
  const check = (arn: string) => {
    if (unusable(arn)) throw new Error(`KMSInvalidStateException: la clave ${arn} no está habilitada o la política no lo permite`);
  };
  return {
    async encrypt(i) {
      check(i.KeyId);
      return { CiphertextBlob: mockWrap(i.KeyId, i.Plaintext, i.EncryptionContext), KeyId: i.KeyId };
    },
    async decrypt(i) {
      const r = mockUnwrap(i.CiphertextBlob, i.EncryptionContext);
      if (i.KeyId && i.KeyId !== r.arn) throw new Error("IncorrectKeyException");
      return { Plaintext: r.plain, KeyId: r.arn };
    },
    async generateDataKey(i) {
      check(i.KeyId);
      const plain = new Uint8Array(randomBytes(32));
      return { Plaintext: plain, CiphertextBlob: mockWrap(i.KeyId, plain, i.EncryptionContext), KeyId: i.KeyId };
    },
    async describeKey(i) {
      if (unusable(i.KeyId)) return { KeyMetadata: { Enabled: false, KeyState: "Disabled", KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "SYMMETRIC_DEFAULT", Arn: i.KeyId } };
      return { KeyMetadata: { Enabled: true, KeyState: "Enabled", KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "SYMMETRIC_DEFAULT", Arn: i.KeyId } };
    },
  };
}

// ───────────── Factory ─────────────

/** KMS simulado: solo fuera de producción y con KMS_MOCK=1. */
export const kmsMockEnabled = () => config.environment !== "prod" && /^(1|true|yes)$/i.test(process.env.KMS_MOCK ?? "");

let factory: ((region: string) => KmsLike) | null = null;
const clients = new Map<string, KmsLike>();

/** Tests: reemplaza el cliente de KMS. `null` vuelve al comportamiento normal. */
export function setKmsClientFactory(f: ((region: string) => KmsLike) | null) {
  factory = f;
  clients.clear();
}

export function kmsClient(region: string): KmsLike {
  const key = region || config.storage.region;
  let c = clients.get(key);
  if (!c) {
    c = factory ? factory(key) : kmsMockEnabled() ? mockKms() : awsKms(key);
    clients.set(key, c);
  }
  return c;
}

/** Cliente para una clave dada (usa la región del ARN). */
export const kmsForKey = (arn: string) => kmsClient(regionOfArn(arn) ?? config.storage.region);

/**
 * true si el error es de KMS (la clave: permisos, estado, inexistente) y no un problema transitorio de red ni un
 * error propio de S3. Un "AccessDenied" de S3 a secas (objeto inexistente sin s3:ListBucket, política del bucket)
 * no es de la clave: antes se le atribuía y la clave del cliente quedaba «failing» con alerta falsa.
 */
export function isKeyError(e: unknown): boolean {
  const err = e as any;
  // Red caída, DNS o timeout (hacia S3 o KMS): no dice nada de la clave. Antes "getaddrinfo ENOTFOUND
  // bucket.s3…" coincidía con /NotFound/i y la clave del cliente quedaba «failing» con aviso a los administradores.
  const code = String(err?.code ?? err?.errno ?? err?.cause?.code ?? "");
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR)/.test(code)) return false;
  if (/^(TimeoutError|AbortError)$/.test(String(err?.name ?? ""))) return false;
  const ids = `${err?.name ?? ""} ${err?.Code ?? ""} ${err?.code ?? ""}`;
  // Excepciones de KMS (SDK de KMS: "DisabledException", "AccessDeniedException"…; S3 con SSE-KMS: "KMS.DisabledException",
  // "KMS.KMSInvalidStateException"…). Las de S3 no terminan en "Exception" ("AccessDenied", "NoSuchKey", "NotFound").
  if (/(^|\s)(KMS\.[A-Za-z]+|KMSInvalidStateException|DisabledException|NotFoundException|InvalidKeyUsageException|IncorrectKeyException|InvalidCiphertextException|KeyUnavailableException|AccessDeniedException|InvalidGrantTokenException)(\s|$)/.test(ids)) return true;
  // Un AccessDenied de S3 es de la clave solo si el mensaje lo dice ("… not authorized to perform: kms:Decrypt …",
  // "The ciphertext refers to a customer master key …"). El KMS simulado usa los mismos nombres al principio del mensaje.
  const msg = String(err?.message ?? e);
  return /\bkms:[A-Za-z]+|customer master key|\bKMS key\b|^(KMSInvalidStateException|IncorrectKeyException|InvalidCiphertextException)\b/.test(msg);
}
