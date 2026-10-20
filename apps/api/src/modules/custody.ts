// Custodia de certificados de las organizaciones (.p12/.pfx). Cifrado de sobre: una clave de datos
// aleatoria cifra el PKCS#8 con AES-256-GCM; la clave de datos se envuelve con KMS (nube) o con la
// SECRET_KEY local (desarrollo). La clave privada nunca sale por la API y solo se descifra en memoria
// para firmar.
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from "node:crypto";
import forge from "node-forge";
import { LocalKeyProvider, type SignatureProvider } from "@calasign/pdf";
import type { TenantCertificate } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { AppError, badRequest, notFound } from "../lib/errors";
import { kmsForKey } from "../infra/kms";

const CUSTODY_PURPOSE = "calasign-tenant-certificate";
import { decrypt, encrypt, iso } from "../lib/util";

export interface ParsedP12 {
  keyPkcs8Pem: string;
  chainPem: string;
  leaf: X509Certificate;
  chainLength: number;
  keyAlgorithm: string;
}

/** Abre un .p12/.pfx, encuentra la clave y su certificado, y ordena la cadena (hoja → raíz). */
export function parseP12(p12: Buffer, password: string): ParsedP12 {
  let p: forge.pkcs12.Pkcs12Pfx;
  try {
    p = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(p12.toString("binary"))), false, password);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/mac|password|invalid/i.test(msg)) throw badRequest("invalid_p12_password", "No se pudo abrir el archivo: la contraseña es incorrecta o el archivo está dañado");
    throw badRequest("invalid_p12", "El archivo no es un .p12/.pfx válido");
  }
  const keyBags = [
    ...(p.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw badRequest("p12_without_key", "El archivo no contiene una clave privada RSA (solo se aceptan claves RSA)");
  const certs = (p.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (!certs.length) throw badRequest("p12_without_cert", "El archivo no contiene certificados");
  const leafForge = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals?.(key.n));
  if (!leafForge) throw badRequest("p12_key_mismatch", "Ningún certificado del archivo corresponde a la clave privada");

  // Cadena: hoja y luego, en orden, cada emisor presente en el archivo.
  const ordered = [leafForge];
  let cur = leafForge;
  for (let i = 0; i < 8; i++) {
    if (cur.isIssuer(cur)) break;
    // forge: a.isIssuer(b) = "b emitió a".
    const issuer = certs.find((c) => c !== cur && !ordered.includes(c) && cur.isIssuer(c));
    if (!issuer) break;
    ordered.push(issuer);
    cur = issuer;
  }
  const toPem = (c: forge.pki.Certificate) => forge.pki.certificateToPem(c).replace(/\r\n/g, "\n");
  const keyPkcs8Pem = forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))).replace(/\r\n/g, "\n");
  const leaf = new X509Certificate(toPem(leafForge));
  return { keyPkcs8Pem, chainPem: ordered.map(toPem).join(""), leaf, chainLength: ordered.length, keyAlgorithm: `RSA-${key.n.bitLength()}` };
}

// ───────────── Cifrado de sobre ─────────────

let kmsP: Promise<{ m: typeof import("@aws-sdk/client-kms"); c: import("@aws-sdk/client-kms").KMSClient }> | null = null;
const kms = () => (kmsP ??= import("@aws-sdk/client-kms").then((m) => ({ m, c: new m.KMSClient({ region: config.storage.region }) })));

/** A quién pertenece la clave: va en el contexto de KMS y en el AAD de AES-GCM (v2). */
export interface CustodyContext {
  tenantId: string;
  certificateId: string;
}

const aad = (ctx: CustodyContext) => Buffer.from(`${CUSTODY_PURPOSE}|${ctx.tenantId}|${ctx.certificateId}`, "utf8");

/** Contexto de cifrado de KMS. v2: atado a la organización y al certificado; v1 (claves anteriores): solo el propósito
 * (BYOK: propósito y organización). */
function kmsContext(version: "v1" | "v2", ctx: { tenantId: string; certificateId?: string }, byok: boolean): Record<string, string> {
  if (version === "v2") return { purpose: CUSTODY_PURPOSE, tenant: ctx.tenantId, certificate: ctx.certificateId ?? "" };
  return byok ? { purpose: CUSTODY_PURPOSE, tenant: ctx.tenantId } : { purpose: CUSTODY_PURPOSE };
}

/**
 * Cifra el PKCS#8 (formato v2): AES-256-GCM con AAD = propósito|organización|certificado, y la clave de datos envuelta
 * con KMS (contexto con organización y certificado), la clave BYOK de la organización o la SECRET_KEY local. Una
 * clave copiada a otra fila (otra organización u otro certificado) no se abre.
 */
export async function sealKey(
  plain: string,
  ctx: CustodyContext,
  byok?: { tenantId: string; keyArn: string } | null,
): Promise<{ ciphertext: string; wrapped: string; method: "local" | "kms" | "kms-byok"; keyArn?: string }> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, iv);
  c.setAAD(aad(ctx));
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const ciphertext = `v2.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
  if (byok) {
    // BYOK: la clave de datos se envuelve con la clave KMS de la organización (contexto atado a la organización).
    try {
      const r = await kmsForKey(byok.keyArn).encrypt({ KeyId: byok.keyArn, Plaintext: dataKey, EncryptionContext: kmsContext("v2", { ...ctx, tenantId: byok.tenantId }, true) });
      return { ciphertext, wrapped: Buffer.from(r.CiphertextBlob).toString("base64"), method: "kms-byok", keyArn: byok.keyArn };
    } catch (e) {
      throw new AppError(503, "byok_key_unavailable", "La clave de cifrado de tu organización (BYOK) no está disponible", { cause: String((e as Error)?.message ?? e).slice(0, 300) });
    } finally {
      dataKey.fill(0);
    }
  }
  try {
    if (config.evidence.custodyKmsKeyId) {
      const { m, c: client } = await kms();
      const r = await client.send(new m.EncryptCommand({ KeyId: config.evidence.custodyKmsKeyId, Plaintext: dataKey, EncryptionContext: kmsContext("v2", ctx, false) }));
      return { ciphertext, wrapped: Buffer.from(r.CiphertextBlob!).toString("base64"), method: "kms" };
    }
    // Local: la clave de datos envuelta lleva el mismo contexto adelante (se controla al abrirla).
    return { ciphertext, wrapped: encrypt(`${aad(ctx).toString("utf8")}|${dataKey.toString("base64")}`), method: "local" };
  } finally {
    // La clave de datos no queda en memoria aunque KMS falle.
    dataKey.fill(0);
  }
}

export interface SealedKeyRow {
  id?: string;
  tenant_id?: string;
  key_ciphertext: string;
  key_wrapped: string;
  key_wrap_method: string;
  key_wrap_key_arn?: string | null;
}

/** Formato de la clave guardada: v2 (contexto con organización y certificado) o v1 (anterior). */
export const keyFormat = (row: Pick<SealedKeyRow, "key_ciphertext">) => (String(row.key_ciphertext).startsWith("v2.") ? "v2" : "v1");

export async function openKey(row: SealedKeyRow): Promise<string> {
  const version = keyFormat(row);
  const ctx = { tenantId: row.tenant_id ?? "", certificateId: row.id ?? "" };
  if (version === "v2" && (!row.tenant_id || !row.id)) throw new Error("falta la organización o el certificado de la clave");
  let dataKey: Buffer;
  if (row.key_wrap_method === "kms-byok") {
    try {
      const r = await kmsForKey(row.key_wrap_key_arn!).decrypt({
        CiphertextBlob: Buffer.from(row.key_wrapped, "base64"),
        KeyId: row.key_wrap_key_arn!,
        EncryptionContext: kmsContext(version, ctx, true),
      });
      dataKey = Buffer.from(r.Plaintext);
    } catch (e) {
      throw new AppError(503, "byok_key_unavailable", "La clave de cifrado de tu organización (BYOK) no está disponible", { cause: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  } else if (row.key_wrap_method === "kms") {
    const { m, c } = await kms();
    const r = await c.send(new m.DecryptCommand({ CiphertextBlob: Buffer.from(row.key_wrapped, "base64"), EncryptionContext: kmsContext(version, ctx, false) }));
    dataKey = Buffer.from(r.Plaintext!);
  } else if (version === "v2") {
    const opened = decrypt(row.key_wrapped);
    const prefix = `${aad(ctx).toString("utf8")}|`;
    if (!opened.startsWith(prefix)) throw new Error("la clave no corresponde a esta organización o certificado");
    dataKey = Buffer.from(opened.slice(prefix.length), "base64");
  } else {
    dataKey = Buffer.from(decrypt(row.key_wrapped), "base64");
  }
  try {
    const [v, iv, enc, tag] = row.key_ciphertext.split(".");
    if (v !== "v1" && v !== "v2") throw new Error("formato de clave desconocido");
    const authTag = Buffer.from(tag ?? "", "base64url");
    if (authTag.length !== 16) throw new Error("etiqueta de cifrado inválida");
    const d = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(iv, "base64url"), { authTagLength: 16 });
    if (v === "v2") d.setAAD(aad(ctx));
    d.setAuthTag(authTag);
    return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
  } finally {
    // También si el descifrado falla (texto alterado, formato desconocido).
    dataKey.fill(0);
  }
}

/**
 * Clave en el formato anterior (v1): se vuelve a cifrar en v2 con el mismo método (BYOK con la misma clave del cliente)
 * después de abrirla. Si falla (KMS caído, otra pasada ya la migró), queda como estaba: se reintenta en el próximo uso.
 */
async function upgradeKey(db: Db, row: any, keyPem: string) {
  if (keyFormat(row) !== "v1" || !row.id || !row.tenant_id) return;
  try {
    const byok = row.key_wrap_method === "kms-byok" && row.key_wrap_key_arn ? { tenantId: row.tenant_id, keyArn: row.key_wrap_key_arn } : null;
    if (row.key_wrap_method === "kms" && !config.evidence.custodyKmsKeyId) return;
    const sealed = await sealKey(keyPem, { tenantId: row.tenant_id, certificateId: row.id }, byok);
    await db.query(
      `UPDATE tenant_certificates SET key_ciphertext = $2, key_wrapped = $3, key_wrap_method = $4
        WHERE id = $1 AND key_ciphertext = $5 AND deleted_at IS NULL`,
      [row.id, sealed.ciphertext, sealed.wrapped, sealed.method, row.key_ciphertext],
    );
  } catch {
    /* se reintenta en el próximo uso */
  }
}

// ───────────── Acceso ─────────────

export const toTenantCertificate = (r: any): TenantCertificate => ({
  id: r.id,
  name: r.name,
  subject: r.subject,
  issuer: r.issuer,
  commonName: r.common_name,
  serialNumber: r.serial_number,
  notBefore: iso(r.not_before)!,
  notAfter: iso(r.not_after)!,
  sha256: r.sha256,
  keyAlgorithm: r.key_algorithm,
  usages: r.usages,
  chainLength: (String(r.chain_pem).match(/BEGIN CERTIFICATE/g) ?? []).length,
  createdAt: iso(r.created_at)!,
  lastUsedAt: iso(r.last_used_at),
  expired: new Date(r.not_after) < new Date(),
});

export async function loadTenantCertificate(db: Db, tenantId: string, id: string, usage?: "xml" | "pdf_seal") {
  const row = await db.one<any>(`SELECT * FROM tenant_certificates WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [id, tenantId]);
  if (!row) throw notFound("Certificado");
  if (usage && !row.usages.includes(usage)) throw badRequest("certificate_usage", `El certificado no está habilitado para ${usage === "xml" ? "firma XML" : "sello de PDF"}`);
  if (new Date(row.not_after) < new Date()) throw badRequest("certificate_expired", "El certificado está vencido");
  return row;
}

/** SignatureProvider con la clave del certificado de la organización (se descifra en memoria). */
export async function tenantCertificateProvider(db: Db, row: any): Promise<SignatureProvider & { level: "advanced" }> {
  const keyPem = await openKey(row);
  await upgradeKey(db, row, keyPem);
  const p = new LocalKeyProvider(`tenant-certificate:${row.id}`, keyPem, row.chain_pem);
  await db.query(`UPDATE tenant_certificates SET last_used_at = now() WHERE id = $1`, [row.id]);
  return Object.assign(p, { level: "advanced" as const });
}
