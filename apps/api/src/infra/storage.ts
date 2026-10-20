import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { config } from "../config";
import { AppError } from "../lib/errors";
import { cellById, cells, type CellStorageConfig } from "./cells";
import { KmsUnavailableError, isKeyError, kmsForKey } from "./kms";

export interface PutOptions {
  /** Clave KMS del cliente (BYOK): S3 la usa como SSE-KMS; en disco se cifra con una clave de datos de esa clave. */
  kmsKeyId?: string | null;
  /** Organización dueña (contexto de cifrado BYOK en disco). */
  tenantId?: string | null;
}

export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Borra el objeto (retención). No falla si ya no existe. */
  delete(key: string): Promise<void>;
}

/** Falla del almacenamiento (o de KMS) que no se atribuye a ninguna clave: 503 genérico, sin ARN. */
export const storageUnavailableError = () =>
  new AppError(503, "storage_unavailable", "El almacenamiento de documentos no está disponible en este momento. Probá de nuevo en unos minutos.");

/**
 * Error de KMS al cifrar o descifrar con la clave `arn`: si es de la clave (permisos, estado, inexistente) se atribuye a
 * ella (KmsUnavailableError); si es transitorio (red, limitación de tasa, falla interna de KMS) es una falla genérica
 * de almacenamiento y la clave no queda «failing».
 */
function kmsFailure(arn: string, e: unknown): Error {
  if (isKeyError(e)) return new KmsUnavailableError(arn, String((e as Error)?.message ?? e));
  console.warn(JSON.stringify({ level: "warn", msg: "falla transitoria de KMS", keyArn: arn, err: String((e as Error)?.message ?? e).slice(0, 300) }));
  return storageUnavailableError();
}

// ───────────── Disco ─────────────

/** Encabezado de archivos cifrados con BYOK en disco: "CSBYOK1\n" + largo (u32) + JSON + cifrado. */
const BYOK_MAGIC = Buffer.from("CSBYOK1\n");

class LocalBlobStore implements BlobStore {
  constructor(private root: string) {}
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("clave inválida");
    return p;
  }
  async put(key: string, data: Uint8Array, _contentType: string, opts?: PutOptions) {
    const p = this.path(key);
    let body: Uint8Array = data;
    if (opts?.kmsKeyId) {
      const ctx = { purpose: "calasign-blob", tenant: opts.tenantId ?? "" };
      let dk: { Plaintext: Uint8Array; CiphertextBlob: Uint8Array };
      try {
        dk = await kmsForKey(opts.kmsKeyId).generateDataKey({ KeyId: opts.kmsKeyId, KeySpec: "AES_256", EncryptionContext: ctx });
      } catch (e) {
        throw kmsFailure(opts.kmsKeyId, e);
      }
      const iv = randomBytes(12);
      const key32 = Buffer.from(dk.Plaintext);
      const c = createCipheriv("aes-256-gcm", key32, iv);
      const enc = Buffer.concat([c.update(data), c.final()]);
      key32.fill(0);
      const header = Buffer.from(
        JSON.stringify({ arn: opts.kmsKeyId, ctx, wrapped: Buffer.from(dk.CiphertextBlob).toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") }),
      );
      const len = Buffer.alloc(4);
      len.writeUInt32BE(header.length);
      body = Buffer.concat([BYOK_MAGIC, len, header, enc]);
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { mode: 0o600 });
  }
  async get(key: string) {
    const raw = await readFile(this.path(key));
    if (!raw.subarray(0, BYOK_MAGIC.length).equals(BYOK_MAGIC)) return new Uint8Array(raw);
    const n = raw.readUInt32BE(BYOK_MAGIC.length);
    const start = BYOK_MAGIC.length + 4;
    const h = JSON.parse(raw.subarray(start, start + n).toString("utf8"));
    let plainKey: Buffer;
    try {
      const r = await kmsForKey(h.arn).decrypt({ CiphertextBlob: Buffer.from(h.wrapped, "base64"), KeyId: h.arn, EncryptionContext: h.ctx });
      plainKey = Buffer.from(r.Plaintext);
    } catch (e) {
      throw kmsFailure(h.arn, e);
    }
    const d = createDecipheriv("aes-256-gcm", plainKey, Buffer.from(h.iv, "base64"));
    d.setAuthTag(Buffer.from(h.tag, "base64"));
    const out = Buffer.concat([d.update(raw.subarray(start + n)), d.final()]);
    plainKey.fill(0);
    return new Uint8Array(out);
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

// ───────────── S3 ─────────────

type S3Mod = typeof import("@aws-sdk/client-s3");
/** Cliente mínimo de S3 (tests: setS3ClientFactory). */
export interface S3Like {
  send(cmd: any): Promise<any>;
}
let s3Factory: ((region: string) => S3Like) | null = null;
/** Tests: reemplaza el cliente de S3. `null` vuelve al SDK real. */
export function setS3ClientFactory(f: ((region: string) => S3Like) | null) {
  s3Factory = f;
}

class S3BlobStore implements BlobStore {
  private clientP: Promise<{ m: S3Mod; c: S3Like }>;
  constructor(
    private bucket: string,
    private prefix: string,
    region: string,
  ) {
    this.clientP = import("@aws-sdk/client-s3").then((m) => ({ m, c: s3Factory ? s3Factory(region) : new m.S3Client({ region }) }));
  }
  async put(key: string, data: Uint8Array, contentType: string, opts?: PutOptions) {
    const { m, c } = await this.clientP;
    await c.send(
      new m.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: data,
        ContentType: contentType,
        ServerSideEncryption: "aws:kms",
        ...(opts?.kmsKeyId ? { SSEKMSKeyId: opts.kmsKeyId, BucketKeyEnabled: true } : {}),
      }),
    );
  }
  async get(key: string) {
    const { m, c } = await this.clientP;
    let r: any;
    try {
      r = await c.send(new m.GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
    } catch (e) {
      // El error de KMS no dice con qué clave está cifrado el objeto (puede ser una clave BYOK anterior o la de la
      // plataforma). HeadObject no necesita KMS y la informa: solo con esa confirmación la falla se atribuye a una
      // clave. Si el HEAD falla o el objeto no dice su clave, la falla no se atribuye a ninguna (503
      // storage_unavailable, no un 500): un AccessDenied de S3 o un objeto inexistente no tienen que dejar «failing» la
      // clave del cliente. Errores que no son de KMS (NoSuchKey, red…) se relanzan como estaban.
      if (isKeyError(e)) {
        const h = await c.send(new m.HeadObjectCommand({ Bucket: this.bucket, Key: this.prefix + key })).catch(() => null);
        if (h?.SSEKMSKeyId) throw new KmsUnavailableError(h.SSEKMSKeyId, String((e as Error)?.message ?? e));
        console.warn(JSON.stringify({ level: "warn", msg: "falla de KMS sin clave confirmada por HeadObject", key, err: String((e as Error)?.message ?? e).slice(0, 300) }));
        throw storageUnavailableError();
      }
      throw e;
    }
    return new Uint8Array(await r.Body!.transformToByteArray());
  }
  /** Borrado definitivo: con versionado activo, un DeleteObject solo agrega una marca; se borran todas las versiones. */
  async delete(key: string) {
    const { m, c } = await this.clientP;
    const Key = this.prefix + key;
    const r = await c.send(new m.ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: Key }));
    const all = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].filter((v: any) => v.Key === Key);
    for (const v of all) await c.send(new m.DeleteObjectCommand({ Bucket: this.bucket, Key, VersionId: v.VersionId }));
    if (all.length === 0) await c.send(new m.DeleteObjectCommand({ Bucket: this.bucket, Key }));
  }
}

export function storeFor(st: CellStorageConfig): BlobStore {
  if (st.driver === "s3") {
    if (!st.bucket) throw new Error("S3_BUCKET requerido");
    return new S3BlobStore(st.bucket, st.prefix ?? "", st.region ?? config.storage.region);
  }
  return new LocalBlobStore(resolve(st.dir ?? resolve(config.dataDir, "blobs")));
}

// ───────────── Enrutamiento por organización (celda + BYOK) ─────────────

export interface TenantStorage {
  cell: string;
  byokKeyArn: string | null;
  byokStatus: "none" | "active" | "failing";
}

/** Lo implementa modules/data/byok.ts (lee tenants, marca la clave como fallida y avisa a los administradores). */
export interface TenantStorageResolver {
  /** `fresh`: leer de la base sin caché (escrituras). */
  resolve(tenantId: string, opts?: { fresh?: boolean }): Promise<TenantStorage>;
  /** La clave es o fue una clave BYOK de la organización (historial tenant_byok_keys). */
  isTenantKey?(tenantId: string, keyArn: string): Promise<boolean>;
  onKeyFailure(tenantId: string, keyArn: string, error: string): Promise<void>;
  onKeySuccess(tenantId: string): Promise<void>;
}

const TENANT_KEY_RE = /^tenants\/([0-9a-f-]{36})\//;

/**
 * Elige el almacenamiento de la celda de la organización (por el prefijo tenants/<id>/ de la clave) y aplica
 * su clave BYOK. Si la clave del cliente no se puede usar, falla cerrado: no se guarda nada sin cifrar con ella.
 */
export class RoutingBlobStore implements BlobStore {
  private stores = new Map<string, BlobStore>();
  constructor(private resolver: TenantStorageResolver) {}

  private storeForCell(cellId: string): BlobStore {
    const cell = cellById(cellId);
    let s = this.stores.get(cell.id);
    if (!s) {
      s = storeFor(cell.storage);
      this.stores.set(cell.id, s);
    }
    return s;
  }

  /** `fresh`: sin caché (escrituras: una clave BYOK cambiada o desactivada en otro proceso no puede seguir usándose). */
  private async target(key: string, fresh = false) {
    const m = TENANT_KEY_RE.exec(key);
    if (!m) return { tenantId: null, store: this.storeForCell(cells().find((c) => c.default)!.id), ts: null as TenantStorage | null };
    const ts = await this.resolver.resolve(m[1], fresh ? { fresh: true } : undefined);
    return { tenantId: m[1], store: this.storeForCell(ts.cell), ts };
  }

  private async keyFailure(tenantId: string, arn: string, e: unknown, mark = true): Promise<never> {
    const msg = String((e as Error)?.message ?? e);
    if (mark) await this.resolver.onKeyFailure(tenantId, arn, msg).catch(() => {});
    throw new AppError(
      503,
      "byok_key_unavailable",
      "La clave de cifrado de tu organización (BYOK) no está disponible: no se pueden guardar ni leer documentos hasta que se restablezca el acceso a la clave.",
      { keyArn: arn, cause: msg.slice(0, 300) },
    );
  }

  /**
   * Falla de KMS de un objeto cifrado con una clave que no es (ni fue) de la organización: p. ej. un archivo anterior a
   * BYOK cifrado con la clave de la plataforma. No se culpa a "la clave de tu organización" ni se expone el ARN interno.
   */
  private storageUnavailable(tenantId: string, arn: string, e: unknown): never {
    console.warn(JSON.stringify({ level: "warn", msg: "falla de KMS con una clave que no es BYOK de la organización", tenantId, keyArn: arn, err: String((e as Error)?.message ?? e).slice(0, 300) }));
    throw storageUnavailableError();
  }
  async put(key: string, data: Uint8Array, contentType: string, opts?: PutOptions) {
    const { tenantId, store, ts } = await this.target(key, true);
    const arn = ts && ts.byokStatus !== "none" ? ts.byokKeyArn : null;
    if (!arn || !tenantId) return store.put(key, data, contentType, opts);
    try {
      await store.put(key, data, contentType, { ...opts, kmsKeyId: arn, tenantId });
    } catch (e) {
      if (e instanceof KmsUnavailableError || isKeyError(e)) return this.keyFailure(tenantId, arn, e);
      throw e;
    }
    if (ts!.byokStatus === "failing") await this.resolver.onKeySuccess(tenantId).catch(() => {});
  }

  async get(key: string) {
    const { tenantId, store, ts } = await this.target(key);
    try {
      return await store.get(key);
    } catch (e) {
      // La falla es de la clave con la que se cifró ESE archivo (confirmada por el almacenamiento: encabezado en disco
      // o HeadObject en S3). Si es la BYOK actual (y activa) se marca fallida; si es una BYOK anterior de la organización
      // se responde igual pero sin marcar la actual; si no es de la organización (la de la plataforma, en un archivo
      // anterior a BYOK), es una falla de almacenamiento genérica. Un error de KMS sin clave confirmada no se le
      // atribuye a ninguna (antes se suponía la actual).
      if (tenantId && e instanceof KmsUnavailableError) {
        const current = ts && ts.byokStatus !== "none" && ts.byokKeyArn === e.keyArn;
        if (current) return this.keyFailure(tenantId, e.keyArn, e);
        const known = ts?.byokKeyArn === e.keyArn || (await this.resolver.isTenantKey?.(tenantId, e.keyArn).catch(() => false));
        if (known) return this.keyFailure(tenantId, e.keyArn, e, false);
        return this.storageUnavailable(tenantId, e.keyArn, e);
      }
      throw e;
    }
  }

  async delete(key: string) {
    const { store } = await this.target(key);
    return store.delete(key);
  }
}

/**
 * Sin resolver: el almacenamiento de siempre (una celda, sin BYOK). Con resolver: enrutamiento por celda y BYOK.
 */
export function createBlobStore(resolver?: TenantStorageResolver): BlobStore {
  if (resolver) return new RoutingBlobStore(resolver);
  return storeFor(cells().find((c) => c.default)!.storage);
}
