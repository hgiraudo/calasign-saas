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
import { badRequest, notFound } from "../lib/errors";
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

export async function sealKey(plain: string): Promise<{ ciphertext: string; wrapped: string; method: "local" | "kms" }> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const ciphertext = `v1.${iv.toString("base64url")}.${enc.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
  if (config.evidence.custodyKmsKeyId) {
    const { m, c: client } = await kms();
    const r = await client.send(
      new m.EncryptCommand({ KeyId: config.evidence.custodyKmsKeyId, Plaintext: dataKey, EncryptionContext: { purpose: "calasign-tenant-certificate" } }),
    );
    dataKey.fill(0);
    return { ciphertext, wrapped: Buffer.from(r.CiphertextBlob!).toString("base64"), method: "kms" };
  }
  const wrapped = encrypt(dataKey.toString("base64"));
  dataKey.fill(0);
  return { ciphertext, wrapped, method: "local" };
}

export async function openKey(row: { key_ciphertext: string; key_wrapped: string; key_wrap_method: string }): Promise<string> {
  let dataKey: Buffer;
  if (row.key_wrap_method === "kms") {
    const { m, c } = await kms();
    const r = await c.send(
      new m.DecryptCommand({ CiphertextBlob: Buffer.from(row.key_wrapped, "base64"), EncryptionContext: { purpose: "calasign-tenant-certificate" } }),
    );
    dataKey = Buffer.from(r.Plaintext!);
  } else {
    dataKey = Buffer.from(decrypt(row.key_wrapped), "base64");
  }
  const [v, iv, enc, tag] = row.key_ciphertext.split(".");
  if (v !== "v1") throw new Error("formato de clave desconocido");
  const d = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
  dataKey.fill(0);
  return plain;
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
  const p = new LocalKeyProvider(`tenant-certificate:${row.id}`, keyPem, row.chain_pem);
  await db.query(`UPDATE tenant_certificates SET last_used_at = now() WHERE id = $1`, [row.id]);
  return Object.assign(p, { level: "advanced" as const });
}
